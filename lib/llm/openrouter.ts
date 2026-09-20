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
      if (e.name === 'AbortError') throw new LLMError('timeout', 'OpenRouter request timed out.');
      throw new LLMError('upstream_error', `OpenRouter request failed: ${e.message}`);
    }
    clearTimeout(timeout);

    if (res.status === 429) {
      throw new LLMError('rate_limited', 'OpenRouter free-tier rate limit reached.');
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new LLMError('upstream_error', `OpenRouter returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json().catch(() => null);
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMError('invalid_response', 'OpenRouter response had no message content.');
    }

    const parsed = extractJson(content);
    if (parsed === null) {
      throw new LLMError('invalid_response', 'Could not parse JSON from model output.');
    }
    return parsed as T;
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

/** Best-effort JSON extraction: strips markdown fences, then tries the
 * whole string, then the widest {...} or [...] span. */
function extractJson(raw: string): unknown | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }

  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try { return JSON.parse(text.slice(firstObj, lastObj + 1)); } catch { /* fall through */ }
  }
  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    try { return JSON.parse(text.slice(firstArr, lastArr + 1)); } catch { /* fall through */ }
  }
  return null;
}
