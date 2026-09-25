import { LLMProvider, LLMJsonOptions, LLMJsonResult, LLMError } from './provider';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Whatever model/router is configured is passed through as an opaque string. No model-specific logic lives in the pipeline. */
export const DEFAULT_MODEL = 'openrouter/free';

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private apiKey: string;
  private siteUrl: string;
  private siteName: string;

  constructor(modelOverride?: string) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY is not set. See .env.example.');
    this.apiKey = key;
    this.model = (modelOverride || process.env.OPENROUTER_MODEL || DEFAULT_MODEL).trim();
    this.siteUrl = process.env.OPENROUTER_SITE_URL || 'http://localhost:3000';
    this.siteName = process.env.OPENROUTER_SITE_NAME || 'SanityGate';
  }

  async completeJSON<T = unknown>(prompt: string, opts: LLMJsonOptions = {}): Promise<LLMJsonResult<T>> {
    const stage = opts.stage || 'llm';
    const timeoutMs = opts.timeoutMs ?? 30000;
    const callStart = Date.now();
    console.error(`[sanitygate:${stage}] calling model=${this.model} timeoutMs=${timeoutMs}`);

    // One controller covers headers AND body: a stalled body read must not outlive the stage budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let attempt = await this.post(prompt, opts, controller.signal, true);
      // Some models/providers reject the optional `reasoning` field. Retry once without it.
      if ([400, 404, 422].includes(attempt.status)) {
        console.error(`[sanitygate:${stage}] HTTP ${attempt.status} with reasoning option; retrying once without it (model=${this.model})`);
        attempt = await this.post(prompt, opts, controller.signal, false);
      }
      return this.interpret<T>(attempt, stage, opts, callStart);
    } catch (e: any) {
      if (e instanceof LLMError) throw e;
      if (e?.name === 'AbortError') {
        console.error(`[sanitygate:${stage}] timeout after ${timeoutMs}ms (model=${this.model})`);
        throw new LLMError('timeout', 'Model request timed out.');
      }
      console.error(`[sanitygate:${stage}] network error (model=${this.model}): ${e?.message}`);
      throw new LLMError('upstream_error', `Model request failed: ${e?.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(prompt: string, opts: LLMJsonOptions, signal: AbortSignal, withReasoning: boolean): Promise<{ status: number; text: string }> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1200,
      messages: [{
        role: 'user',
        content: prompt + '\n\nRespond with ONLY the JSON object described above. No markdown fences, no commentary before or after.',
      }],
    };
    if (withReasoning) body.reasoning = { exclude: true };   // best-effort; not verified against a live call
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.siteName,
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();   // inside the abort scope
    return { status: res.status, text };
  }

  private interpret<T>(r: { status: number; text: string }, stage: string, opts: LLMJsonOptions, callStart: number): LLMJsonResult<T> {
    if (r.status === 429) {
      console.error(`[sanitygate:${stage}] rate limited (model=${this.model})`);
      throw new LLMError('rate_limited', 'Rate limit reached.');
    }
    if (r.status < 200 || r.status >= 300) {
      console.error(`[sanitygate:${stage}] upstream HTTP ${r.status} (model=${this.model}): ${r.text.slice(0, 300)}`);
      throw new LLMError('upstream_error', `Upstream returned ${r.status}`);
    }
    let data: any = null;
    try { data = JSON.parse(r.text); } catch { /* handled below */ }

    // OpenRouter can return HTTP 200 with an error object in the body.
    if (data?.error && !data?.choices?.length) {
      const code = Number(data.error.code);
      console.error(`[sanitygate:${stage}] provider error in 200 body code=${data.error.code} (model=${this.model}): ${String(data.error.message || '').slice(0, 200)}`);
      throw new LLMError(code === 429 ? 'rate_limited' : 'upstream_error', 'Provider reported an error.');
    }

    const choice = data?.choices?.[0];
    const content: unknown = choice?.message?.content;
    const finishReason: string = choice?.finish_reason ?? 'unknown';
    if (typeof content !== 'string' || !content.trim()) {
      console.error(`[sanitygate:${stage}] empty response body (model=${this.model}, finish_reason=${finishReason})`);
      throw new LLMError('invalid_response', 'Model returned no content.');
    }
    const parsed = extractJson(content);
    if (parsed === null) {
      console.error(`[sanitygate:${stage}] unparseable output (model=${this.model}, finish_reason=${finishReason}, len=${content.length})`);
      throw new LLMError('invalid_response', 'Could not parse JSON from model output.');
    }
    const partial = parsed.salvaged || (finishReason === 'length' && !parsed.exact);
    if (partial) console.error(`[sanitygate:${stage}] partial result recovered (model=${this.model}, finish_reason=${finishReason})`);
    console.error(`[sanitygate:${stage}] completed in ${Date.now() - callStart}ms (model=${this.model}, finish_reason=${finishReason}, len=${content.length})`);
    return { value: parsed.value as T, partial };
  }
}

export interface JsonExtractionResult {
  value: unknown;
  salvaged: boolean;   // strict parse failed; a repaired prefix was recovered
  exact: boolean;      // strict parse of the full text/span succeeded
}

/**
 * Best-effort JSON extraction. Order: strict parse -> widest {...}/[...] span ->
 * truncation repair (keep every COMPLETE nested value up to the cutoff and
 * close the open brackets). Repair is generic, so it works for every response
 * shape in this app (requirements, judgments, verdicts, findings).
 */
export function extractJson(raw: string): JsonExtractionResult | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try { return { value: JSON.parse(text), salvaged: false, exact: true }; } catch { /* next */ }

  const o1 = text.indexOf('{'), o2 = text.lastIndexOf('}');
  if (o1 >= 0 && o2 > o1) {
    try { return { value: JSON.parse(text.slice(o1, o2 + 1)), salvaged: false, exact: true }; } catch { /* next */ }
  }
  const a1 = text.indexOf('['), a2 = text.lastIndexOf(']');
  if (a1 >= 0 && a2 > a1 && (o1 < 0 || a1 < o1)) {
    try { return { value: JSON.parse(text.slice(a1, a2 + 1)), salvaged: false, exact: true }; } catch { /* next */ }
  }

  const start = o1 >= 0 && (a1 < 0 || o1 < a1) ? o1 : a1;
  if (start < 0) return null;
  const repaired = repairTruncated(text.slice(start));
  if (repaired === null) return null;
  return { value: repaired, salvaged: true, exact: false };
}

function repairTruncated(text: string): unknown | null {
  const stack: string[] = [];
  let inStr = false, esc = false;
  let safeIdx = -1;
  let safeStack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      safeIdx = i + 1;
      safeStack = [...stack];
    }
  }
  if (safeIdx < 0 || safeStack.length === 0) return null;   // nothing complete and nested to keep
  const closers = safeStack.reverse().map(c => (c === '{' ? '}' : ']')).join('');
  try { return JSON.parse(text.slice(0, safeIdx) + closers); } catch { return null; }
}
