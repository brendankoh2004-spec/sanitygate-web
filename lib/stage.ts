import { LLMProvider, LLMError } from './llm/provider';
import { StageDiagnostic } from './types';

/** Below this much remaining time a call has no realistic chance of finishing before the platform kills the function. */
export const MIN_VIABLE_MS = 4000;
/** A retry is only worth attempting with at least this much time left. */
export const MIN_RETRY_MS = 10000;

export type StageOutcome<T> =
  | { ok: true; value: T; partial: boolean; attempts: number }
  | { ok: false; code: string; attempts: number };

export interface Validated<T> {
  value: T;
  /** false => the response parsed but is known to be incomplete (e.g. some requirement ids were never judged). */
  complete: boolean;
}

export interface StageSpec<T> {
  name: string;
  provider: LLMProvider;
  prompt: string;
  desiredMs: number;
  /** Absolute epoch-ms deadline for this stage (attempts + retry). */
  deadline: number;
  maxTokens: number;
  diagnostics: StageDiagnostic[];
  /** Returns null when the shape is unusable. Must not throw. */
  validate: (raw: unknown) => Validated<T> | null;
}

/**
 * Runs one model call with validation and ONE bounded retry.
 *  - retried: invalid/unusable shape, partial/truncated, incomplete coverage, upstream error
 *  - NOT retried: timeout, rate limit (retrying just burns the remaining budget)
 * If the last attempt is only partial, the partial value is returned with
 * partial=true (never silently promoted to complete). Never throws.
 */
export async function runStage<T>(spec: StageSpec<T>): Promise<StageOutcome<T>> {
  const t0 = Date.now();
  let attempts = 0;
  let lastCode = 'timeout';
  let partialValue: T | null = null;

  const record = (ok: boolean, code: string | null, partial: boolean) => {
    spec.diagnostics.push({
      stage: spec.name,
      ok,
      code,
      attempts,
      ms: Date.now() - t0,
      partial,
      model: spec.provider.model,
    });
  };

  while (attempts < 2) {
    const remaining = spec.deadline - Date.now();

    // First attempt needs a realistic amount of time.
    // Retry needs less because it is a recovery attempt and must
    // not consume the protected time of later pipeline stages.
    const minimumRequired =
      attempts === 0 ? MIN_VIABLE_MS : MIN_RETRY_MS;

    if (remaining < minimumRequired) {
      if (attempts === 0) {
        console.error(
          `[sanitygate:${spec.name}] skipped — insufficient time budget`,
        );
        lastCode = 'timeout';
      } else {
        console.error(
          `[sanitygate:${spec.name}] retry skipped — insufficient time budget`,
        );
      }
      break;
    }

    attempts++;

    // First attempt gets the normal desired budget.
    // Retry gets at most 8 seconds, preventing a second long model call
    // from consuming the remaining pipeline budget.
    const timeoutMs =
      attempts === 1
        ? Math.min(spec.desiredMs, remaining)
        : Math.min(8000, remaining);

    try {
      const r = await spec.provider.completeJSON<unknown>(
        spec.prompt,
        {
          temperature: 0.1,
          maxTokens: spec.maxTokens,
          timeoutMs,
          stage: spec.name,
        },
      );

      const v = spec.validate(r?.value);

      if (!v) {
        lastCode = 'invalid_response';

        console.error(
          `[sanitygate:${spec.name}] attempt ${attempts}: unusable response shape`,
        );

        // Don't spend another long call recovering a completely
        // unusable response unless enough time remains.
        continue;
      }

      if (r.partial || !v.complete) {
        partialValue = v.value;
        lastCode = 'invalid_response';

        console.error(
          `[sanitygate:${spec.name}] attempt ${attempts}: incomplete response ` +
          `(${r.partial ? 'truncated' : 'coverage gap'})`,
        );

        continue;
      }

      record(true, null, false);

      return {
        ok: true,
        value: v.value,
        partial: false,
        attempts,
      };
    } catch (e) {
      const code =
        e instanceof LLMError ? e.code : 'upstream_error';

      lastCode = code;

      console.error(
        `[sanitygate:${spec.name}] attempt ${attempts} failed: ${code}`,
      );

      // Timeout and rate-limit are not retried.
      // A retry cannot realistically improve the result inside
      // the remaining pipeline budget.
      if (code === 'timeout' || code === 'rate_limited') {
        break;
      }
    }
  }

  // A partial result is explicitly marked partial.
  // It is never silently promoted to a complete result.
  if (partialValue !== null) {
    record(true, 'partial', true);

    return {
      ok: true,
      value: partialValue,
      partial: true,
      attempts,
    };
  }

  record(false, lastCode, false);

  return {
    ok: false,
    code: lastCode,
    attempts,
  };
}
