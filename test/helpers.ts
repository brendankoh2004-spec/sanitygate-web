import { LLMProvider, LLMError, LLMJsonOptions, LLMJsonResult } from '../lib/llm/provider';
import { Providers } from '../lib/pipeline';

let pass = 0, fail = 0;
export function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`OK   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}
export function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

export type ReplyValue = unknown;
export interface Special { __partial?: boolean; __delay?: number; __error?: LLMError | Error; value?: unknown }
export type Reply = ReplyValue | Special | ((prompt: string, n: number) => ReplyValue | Special | Promise<ReplyValue | Special>);

/**
 * Scripted model double. `handlers` maps a stage-name prefix ('extraction' | 'evaluator' | 'verify' | 'scan')
 * to a reply, a function of (prompt, callIndex), or an array (successive calls; the last entry repeats).
 * Honors timeoutMs so budget/timeouts behave like the real provider.
 */
export class Scripted implements LLMProvider {
  name = 'scripted'; model = 'scripted-model';
  calls: { stage: string; prompt: string; timeoutMs?: number }[] = [];
  private counters: Record<string, number> = {};
  constructor(private handlers: Record<string, Reply | Reply[]>) {}

  callsFor(prefix: string) { return this.calls.filter(c => c.stage.startsWith(prefix)); }

  async completeJSON<T>(prompt: string, opts: LLMJsonOptions = {}): Promise<LLMJsonResult<T>> {
    const stage = opts.stage || 'unknown';
    this.calls.push({ stage, prompt, timeoutMs: opts.timeoutMs });
    const key = Object.keys(this.handlers).find(k => stage.startsWith(k));
    if (!key) throw new LLMError('upstream_error', `no handler for stage ${stage}`);
    const n = (this.counters[key] = (this.counters[key] ?? -1) + 1);
    let h = this.handlers[key];
    if (Array.isArray(h)) h = h[Math.min(n, h.length - 1)];
    let r: any = typeof h === 'function' ? await (h as Function)(prompt, n) : h;
    if (r instanceof Error) throw r;
    if (r && typeof r === 'object' && ('__error' in r || '__delay' in r || '__partial' in r)) {
      if (r.__delay) {
        const wait = Math.min(r.__delay, opts.timeoutMs ?? r.__delay);
        await new Promise(res => setTimeout(res, wait));
        if (r.__delay > (opts.timeoutMs ?? Infinity)) throw new LLMError('timeout', 'simulated timeout');
      }
      if (r.__error) throw r.__error;
      return { value: (r.value ?? r) as T, partial: !!r.__partial };
    }
    return { value: r as T, partial: false };
  }
}

export const allOf = (p: LLMProvider): Providers => ({ extraction: p, evaluator: p, verifier: p });

// ---- response builders ---------------------------------------------------
export const item = (kind: 'instruction' | 'fact', category: string, text: string, quote: string) => ({ kind, category, text, quote });
export const ledgerOf = (...items: ReturnType<typeof item>[]) => ({ items });

/** Parses the ledger the evaluator prompt was given, so scripted evaluators can answer by requirement id. */
export function ledgerFromPrompt(prompt: string): { id: string; kind: string; category: string | null; text: string; quote: string }[] {
  const marker = 'REQUIREMENTS TO JUDGE';
  const i = prompt.indexOf(marker);
  const line = prompt.slice(prompt.indexOf('\n', i) + 1).split('\n')[0];
  return JSON.parse(line);
}
export const satisfied = (id: string, output_quote?: string) => ({ id, verdict: 'satisfied', ...(output_quote ? { output_quote } : {}) });
export const notApplicable = (id: string) => ({ id, verdict: 'not_applicable' });
export const NO_UNREQUESTED = { unrequested: [] as unknown[] };

export const verdictOf = (cid: string, o: Partial<{ verdict: string; request_quote: string; output_quote: string; same_subject: string; fix_ok: boolean; better_fix: unknown; reason: string }> = {}) =>
  ({ cid, request_quote: '', output_quote: '', request_means: '', output_means: '', same_subject: 'yes', verdict: 'confirmed', fix_ok: true, better_fix: null, reason: 'ok', ...o });
