import { LLMProvider, LLMJsonOptions, LLMError } from './provider';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter provider. Uses whatever model is configured in
 * OPENROUTER_MODEL (default: a free model — verify current availability
 * at https://openrouter.ai/models?max_price=0 before deploying, since
 * OpenRouter's free-model lineup changes over time and free models are
 * rate-limited per OpenRouter account, not unlimited).
 *
 * We do not rely on OpenRouter's structured-output / JSON-mode support
 * because not all free models honor `response_format`. Instead the
 * caller's prompt explicitly demands JSON-only output, and this class
 * does best-effort extraction + parsing, throwing LLMError('invalid_response')
 * if the model's output cannot be parsed as JSON at all.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private apiKey: string;
  private siteUrl: string;
  private siteName: string;

  constructor(modelOverride?: string) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error('OPENROUTER_API_KEY is not set. See .env.example.');
    }
    this.apiKey = key;
    this.model = modelOverride || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
    this.siteUrl = process.env.OPENROUTER_SITE_URL || 'http://localhost:3000';
    this.siteName = process.env.OPENROUTER_SITE_NAME || 'SanityGate';
  }

  async completeJSON<T = unknown>(prompt: string, opts: LLMJsonOptions = {}): Promise<T> {
    const stage = opts.stage || 'llm';
    const callStart = Date.now();
    // Start-of-call marker with no prompt/document content — this is what
    // lets production logs answer "did call N even start" independently
    // of whether it later failed. Previously only failure paths logged
    // anything, so a successful-but-slow call was invisible until it
    // either finished (silently) or the whole request's duration was
    // inspected after the fact.
    console.error(`[sanitygate:${stage}] calling model=${this.model} timeoutMs=${opts.timeoutMs ?? 30000}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.siteUrl,
          'X-Title': this.siteName,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: opts.temperature ?? 0.1,
          max_tokens: opts.maxTokens ?? 1200,
          // Best-effort mitigation for reasoning-capable models: some free
          // OpenRouter models spend hidden "thinking" tokens against the
          // same max_tokens budget before ever emitting visible content,
          // which can exhaust the budget and return finish_reason="length"
          // with an EMPTY message.content — a strong signature we've seen
          // in production. OpenRouter's reasoning-control API lets a
          // request opt out of this for models that support it; models/
          // providers that don't recognize the field simply ignore it, so
          // this is safe to send unconditionally. Not verified against a
          // live call in this environment — treat as best-effort, not
          // confirmed, until tested with a real API key.
          reasoning: { exclude: true },
          messages: [
            {
              role: 'user',
              content: prompt + '\n\nRespond with ONLY the JSON object/array described above. No markdown fences, no commentary, no prose before or after the JSON.',
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') {
        console.error(`[sanitygate:${stage}] timeout after ${opts.timeoutMs ?? 30000}ms (model=${this.model})`);
        throw new LLMError('timeout', 'OpenRouter request timed out.');
      }
      console.error(`[sanitygate:${stage}] network error (model=${this.model}): ${e.message}`);
      throw new LLMError('upstream_error', `OpenRouter request failed: ${e.message}`);
    }
    clearTimeout(timeout);

    if (res.status === 429) {
      console.error(`[sanitygate:${stage}] rate limited by OpenRouter (model=${this.model})`);
      throw new LLMError('rate_limited', 'OpenRouter free-tier rate limit reached.');
    }
    if (!res.ok) {
      const body = await safeText(res);
      console.error(`[sanitygate:${stage}] upstream HTTP ${res.status} (model=${this.model}): ${body.slice(0, 300)}`);
      throw new LLMError('upstream_error', `OpenRouter returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    const content: string | undefined = choice?.message?.content;
    const finishReason: string | undefined = choice?.finish_reason;
    if (!content) {
      console.error(`[sanitygate:${stage}] empty response body (model=${this.model}, finish_reason=${finishReason ?? 'unknown'})`);
      throw new LLMError('invalid_response', 'OpenRouter response had no message content.');
    }
    if (finishReason === 'length') {
      // Diagnostic only, not fatal on its own — extractJson's salvage
      // path may still recover a usable partial result from this.
      console.error(`[sanitygate:${stage}] response hit max_tokens and was truncated by the model (model=${this.model}, maxTokens=${opts.maxTokens ?? 1200}, contentLength=${content.length})`);
    }

    const parsed = extractJson(content);
    if (parsed === null) {
      console.error(`[sanitygate:${stage}] could not parse JSON from model output, even with salvage (model=${this.model}, finish_reason=${finishReason ?? 'unknown'}, contentLength=${content.length})`);
      throw new LLMError('invalid_response', 'Could not parse JSON from model output.');
    }
    if (parsed.salvaged) {
      console.error(`[sanitygate:${stage}] recovered a partial result from a truncated/malformed response (model=${this.model}, finish_reason=${finishReason ?? 'unknown'})`);
    }
    console.error(`[sanitygate:${stage}] completed in ${Date.now() - callStart}ms (model=${this.model}, finish_reason=${finishReason ?? 'unknown'}, contentLength=${content.length})`);
    return parsed.value as T;
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

export interface JsonExtractionResult {
  value: unknown;
  /** true if the strict parse failed and we recovered a partial result
   * by scanning for complete objects inside a truncated/malformed
   * response — callers should treat this as a signal worth logging
   * (it means the model's output was cut off or malformed), even though
   * the recovered data itself is usable. */
  salvaged: boolean;
}

/** Best-effort JSON extraction: strips markdown fences, then tries the
 * whole string, then the widest {...} or [...] span, then — if the
 * response was truncated mid-way (very common on free/small models when
 * max_tokens runs out before a long list of findings is fully written) —
 * salvages whichever complete {...} objects appear before the cutoff
 * rather than discarding the entire response over one incomplete
 * trailing object. */
export function extractJson(raw: string): JsonExtractionResult | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try { return { value: JSON.parse(text), salvaged: false }; } catch { /* fall through */ }

  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try { return { value: JSON.parse(text.slice(firstObj, lastObj + 1)), salvaged: false }; } catch { /* fall through */ }
  }
  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    try { return { value: JSON.parse(text.slice(firstArr, lastArr + 1)), salvaged: false }; } catch { /* fall through */ }
  }

  // Salvage path: the response is truncated or otherwise malformed as a
  // whole. If it looks like {"issues": [ {...}, {...}, <cut off> ]}, keep
  // every complete object up to the cutoff. If it looks like a bare
  // array (the verifier's shape), do the same directly.
  const issuesKeyIdx = text.indexOf('"issues"');
  if (issuesKeyIdx >= 0) {
    const arrIdx = text.indexOf('[', issuesKeyIdx);
    if (arrIdx >= 0) {
      const objs = salvageObjectArray(text, arrIdx);
      if (objs && objs.length) return { value: { issues: objs }, salvaged: true };
    }
  }
  const bareArrIdx = text.indexOf('[');
  if (bareArrIdx >= 0) {
    const objs = salvageObjectArray(text, bareArrIdx);
    if (objs && objs.length) return { value: objs, salvaged: true };
  }

  return null;
}

/** Scans a JSON array starting at `arrayStart` (the index of '[') and
 * returns every syntactically-complete top-level {...} object found
 * before the array either closes normally or truncates mid-object.
 * String literals (including escaped quotes/braces inside them) are
 * tracked so brace-counting doesn't get confused by braces that appear
 * inside a quoted "explanation" or "reason" field. */
function salvageObjectArray(text: string, arrayStart: number): any[] | null {
  const objs: any[] = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] !== '{') break;

    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
      }
    }
    if (depth !== 0) break; // truncated mid-object — stop, discard the incomplete tail
    try { objs.push(JSON.parse(text.slice(i, j))); } catch { /* skip a malformed individual object, keep scanning is unsafe once one fails to parse cleanly */ break; }
    i = j;
  }
  return objs.length ? objs : null;
}
