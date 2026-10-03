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

export interface Special { __partial?: boolean; __delay?: number; __error?: LLMError | Error; value?: unknown }
export type Reply = unknown | Special | ((prompt: string, n: number) => unknown | Special | Promise<unknown | Special>);

/**
 * Scripted model double. `handlers` maps a role/stage-name prefix ('direct' | 'coverage' | 'reverse' | 'adjudicator')
 * to a reply, a function of (prompt, callIndex), or an array (successive calls; the last entry repeats).
 * Records when each call STARTED so tests can prove concurrency. Honors timeoutMs like the real provider.
 */
export class Scripted implements LLMProvider {
  name = 'scripted'; model = 'scripted-model';
  calls: { stage: string; prompt: string; timeoutMs?: number; startedAt: number }[] = [];
  private counters: Record<string, number> = {};
  constructor(private handlers: Record<string, Reply | Reply[]>) {}

  callsFor(prefix: string) { return this.calls.filter(c => c.stage.startsWith(prefix)); }

  async completeJSON<T>(prompt: string, opts: LLMJsonOptions = {}): Promise<LLMJsonResult<T>> {
    const stage = opts.stage || 'unknown';
    this.calls.push({ stage, prompt, timeoutMs: opts.timeoutMs, startedAt: Date.now() });
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

export const allOf = (p: LLMProvider): Providers => ({ direct: p, coverage: p, reverse: p, adjudicator: p });
export const NO_PROVIDERS: Providers = { direct: null, coverage: null, reverse: null, adjudicator: null };

// ---- response builders ---------------------------------------------------
export const PASS = { status: 'pass', issues: [] as unknown[] };
export const issue = (type: string, o: Partial<{ request_evidence: string; output_evidence: string; reason: string }> = {}) =>
  ({ type, request_evidence: '', output_evidence: '', reason: 'reviewer reason', ...o });
export const issues = (...list: ReturnType<typeof issue>[]) => ({ status: 'issues', issues: list });
export const decision = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, verdict: 'confirmed', severity: 'critical', reason: 'adjudicated', fix: null, ...o });

/** Parses the candidate lines the adjudicator prompt was given. */
export function candidatesFromPrompt(prompt: string): { id: string; source: string; type: string; request_evidence: string; output_evidence: string; reason: string; output_answers?: string }[] {
  const a = prompt.indexOf('--- CANDIDATES ---') + '--- CANDIDATES ---'.length;
  const b = prompt.indexOf('--- DETERMINISTIC FAILURES');
  return prompt.slice(a, b).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
export function deterministicFromPrompt(prompt: string): string {
  const a = prompt.indexOf('--- DETERMINISTIC FAILURES');
  return prompt.slice(prompt.indexOf('\n', a) + 1, prompt.indexOf('--- REQUEST ---')).trim();
}
