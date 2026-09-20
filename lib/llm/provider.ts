export type LLMErrorCode = 'rate_limited' | 'timeout' | 'upstream_error' | 'invalid_response';

export class LLMError extends Error {
  code: LLMErrorCode;
  constructor(code: LLMErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LLMError';
  }
}

/** Which stage of the pipeline is calling the provider. Evaluator and
 * verifier can be configured to use different models/providers
 * independently (spec section 24) — extraction shares the evaluator's
 * model by default since it's conceptually the first half of the same
 * "understand + judge" job, but that's a default, not a constraint. */
export type LLMRole = 'extraction' | 'evaluator' | 'verifier';

export interface LLMJsonOptions {
  /** Lower temperature for more deterministic structured output. */
  temperature?: number;
  maxTokens?: number;
  /** Abort the call after this many ms. */
  timeoutMs?: number;
}

/**
 * Provider-agnostic interface. Every provider implementation must:
 *  - accept a single text prompt (system framing is baked into the prompt
 *    string by the caller — see lib/prompts.ts — since not every free
 *    model / API supports a separate system role reliably)
 *  - return parsed JSON matching whatever shape the caller asked for in
 *    the prompt
 *  - throw LLMError with a specific code on failure, NEVER return a
 *    silently-empty/successful result on failure. This is load-bearing:
 *    the pipeline treats "no error thrown, empty issues array" as a
 *    genuine clean result, and "error thrown" as "could not evaluate".
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  completeJSON<T = unknown>(prompt: string, opts?: LLMJsonOptions): Promise<T>;
}
