export type LLMErrorCode = 'rate_limited' | 'timeout' | 'upstream_error' | 'invalid_response';

export class LLMError extends Error {
  code: LLMErrorCode;
  constructor(code: LLMErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LLMError';
  }
}

/** Pipeline stage using the provider. Each can be pointed at a different model (optional). */
export type LLMRole = 'extraction' | 'evaluator' | 'verifier';

export interface LLMJsonOptions {
  temperature?: number;
  maxTokens?: number;
  /** Aborts the whole call (headers AND body) after this many ms. */
  timeoutMs?: number;
  /** Diagnostics label only; never sent to the provider. */
  stage?: string;
}

export interface LLMJsonResult<T = unknown> {
  value: T;
  /** true = the response was truncated/malformed and only a repaired prefix was recovered. Callers must not treat a partial result as complete. */
  partial: boolean;
}

/**
 * Provider contract:
 *  - returns parsed JSON (possibly partial), or
 *  - throws LLMError. NEVER returns a silently-empty success on failure —
 *    the pipeline treats "returned" as "the model answered" and "threw" as
 *    "could not evaluate".
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  completeJSON<T = unknown>(prompt: string, opts?: LLMJsonOptions): Promise<LLMJsonResult<T>>;
}
