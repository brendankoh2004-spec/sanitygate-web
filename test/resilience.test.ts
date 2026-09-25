/**
 * Resilience / failure-handling tests (spec section 13 "Failure handling"
 * and section 6). These test runStage (the shared retry/validation wrapper
 * every model call goes through) directly for fine-grained control, plus a
 * few full-pipeline scenarios for partial failures and the platform
 * timeout boundary.
 */
import { runStage, MIN_VIABLE_MS } from '../lib/stage';
import { runPipeline } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL, StageDiagnostic } from '../lib/types';
import { LLMProvider, LLMError, LLMJsonOptions, LLMJsonResult } from '../lib/llm/provider';
import { check, done, Scripted, allOf } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };

/** A minimal provider whose single behaviour is scripted per test, with a call counter. */
class Fake implements LLMProvider {
  name = 'fake'; model = 'fake-model'; calls = 0;
  constructor(private behavior: (n: number) => Promise<unknown>) {}
  async completeJSON<T>(_prompt: string, _opts?: LLMJsonOptions): Promise<LLMJsonResult<T>> {
    this.calls++;
    return { value: (await this.behavior(this.calls)) as T, partial: false };
  }
}
const okShape = { ok: true };
const validateOk = (raw: unknown) => (raw && typeof raw === 'object' ? { value: raw, complete: true } : null);
const spec = (provider: LLMProvider, deadline: number, extra: Partial<Parameters<typeof runStage>[0]> = {}) => ({
  name: 'test', provider, prompt: 'p', desiredMs: 5000, deadline, maxTokens: 100,
  diagnostics: [] as StageDiagnostic[], validate: validateOk, ...extra,
});

async function main() {

// ---- empty model response -----------------------------------------------
{
  const p = new Fake(async () => { throw new LLMError('invalid_response', 'empty'); });
  const r = await runStage(spec(p, Date.now() + 30000));
  check('empty response -> stage fails with invalid_response after retry', !r.ok && r.code === 'invalid_response' && r.attempts === 2 && p.calls === 2);
}

// ---- malformed JSON (validate() rejects the shape) -----------------------
{
  const p = new Fake(async () => ({ garbage: true }));
  const r = await runStage({ ...spec(p, Date.now() + 30000), validate: () => null });
  check('malformed/unusable shape -> retried once then fails invalid_response', !r.ok && r.code === 'invalid_response' && p.calls === 2);
}

// ---- truncated response: partial is retried, and if it never completes it is still returned (never silently upgraded) ----
{
  let calls = 0;
  const p: LLMProvider = { name: 'fake', model: 'x', completeJSON: async () => { calls++; return { value: okShape as any, partial: true }; } };
  const r = await runStage(spec(p, Date.now() + 30000));
  check('always-truncated response: retried once, then returned as partial=true (not promoted to complete)', r.ok && r.partial === true && r.attempts === 2 && calls === 2);
}
{
  let calls = 0;
  const p: LLMProvider = { name: 'fake', model: 'x', completeJSON: async () => { calls++; return { value: okShape as any, partial: calls === 1 }; } };
  const r = await runStage(spec(p, Date.now() + 30000));
  check('truncated once, then a clean retry -> ok and NOT partial', r.ok && r.partial === false && calls === 2);
}

// ---- timeout: never retried (retrying would just burn the remaining budget) ----
{
  const p = new Fake(async () => { throw new LLMError('timeout', 'simulated'); });
  const r = await runStage(spec(p, Date.now() + 30000));
  check('timeout -> NOT retried, fails immediately with timeout', !r.ok && r.code === 'timeout' && r.attempts === 1 && p.calls === 1);
}

// ---- rate limit: never retried ----
{
  const p = new Fake(async () => { throw new LLMError('rate_limited', 'simulated'); });
  const r = await runStage(spec(p, Date.now() + 30000));
  check('rate limit -> NOT retried, fails immediately with rate_limited', !r.ok && r.code === 'rate_limited' && r.attempts === 1 && p.calls === 1);
}

// ---- provider/upstream error: retried once ----
{
  const p = new Fake(async () => { throw new LLMError('upstream_error', 'simulated 5xx'); });
  const r = await runStage(spec(p, Date.now() + 30000));
  check('upstream error -> retried once, then fails upstream_error', !r.ok && r.code === 'upstream_error' && p.calls === 2);
}
{
  let calls = 0;
  const p: LLMProvider = { name: 'fake', model: 'x', completeJSON: async () => { calls++; if (calls === 1) throw new LLMError('upstream_error', 'transient'); return { value: okShape as any, partial: false }; } };
  const r = await runStage(spec(p, Date.now() + 30000));
  check('upstream error then success -> ok, recovers via the retry', r.ok && !r.partial && calls === 2);
}

// ---- Vercel/platform timeout boundary: a deadline already in the past skips the call entirely ----
{
  const p = new Fake(async () => okShape);
  const r = await runStage(spec(p, Date.now() - 1000));
  check('deadline already passed -> stage skipped without calling the provider at all', !r.ok && r.code === 'timeout' && p.calls === 0);
}
{
  const p = new Fake(async () => okShape);
  const r = await runStage(spec(p, Date.now() + MIN_VIABLE_MS - 500));
  check('deadline leaves less than the minimum viable window -> skipped, not attempted', !r.ok && p.calls === 0);
}

// ---- partial pipeline failure: extraction fails -> ledger degrades to sentence-level requirements, review still completes ----
{
  const REQUEST = 'Do not mention any competitor by name. Revenue was $8.42 million.';
  const OUTPUT = 'Unlike RivalCorp, revenue was $8.42 million.';
  const p = new Scripted({
    extraction: () => { throw new LLMError('invalid_response', 'always garbled'); },
    evaluator: (prompt: string) => {
      // Every ledger item is now an "unclassified" sentence (extraction never ran); judge generically by content.
      const idMatches = [...prompt.matchAll(/"id":"(R\d+)"/g)].map(m => m[1]);
      const textMatches = [...prompt.matchAll(/"text":"([^"]*)"/g)].map(m => m[1]);
      return {
        judgments: idMatches.map((id, i) => /competitor/i.test(textMatches[i] || '')
          ? { id, verdict: 'violated', category: 'instruction_violation', severity: 'critical', output_quote: 'Unlike RivalCorp,', same_subject: 'n/a', not_equivalent_because: 'names a competitor', reason: 'Names RivalCorp.', fix: { original: 'Unlike RivalCorp, ', replacement: '' } }
          : { id, verdict: 'not_applicable' }),
        unrequested: [],
      };
    },
    verify: () => ({ verifications: [{ cid: 'C1', request_quote: 'Do not mention any competitor by name.', output_quote: 'Unlike RivalCorp,', request_means: '', output_means: '', same_subject: 'n/a', verdict: 'confirmed', fix_ok: true, better_fix: null, reason: 'ok' }] }),
    scan: { findings: [] },
  });
  const r = await runPipeline(allOf(p), REQUEST, OUTPUT, adv);
  check('extraction failure degrades gracefully: requirements come from sentence fallback, not silently empty', r.requirements.length > 0 && r.requirements.every(x => x.kind === 'unclassified'));
  check('extraction failure alone does not force an incomplete review (documented graceful degradation)', r.checkStatus !== 'check_incomplete');
  check('the review still catches a real violation despite the degraded ledger', r.findings.length === 1 && r.findings[0].strength === 'confirmed');
}

// ---- providers entirely unavailable (no API key configured) -> incomplete, never crashes, never "clean" ----
{
  const r = await runPipeline({ extraction: null, evaluator: null, verifier: null }, 'Do X.', 'did X', adv);
  check('no provider configured -> check_incomplete, not clean, not a thrown error', r.checkStatus === 'check_incomplete' && r.incompleteReason === 'general');
}

// ---- unexpected internal exception during semantic review -> degrades to incomplete, never crashes the request ----
{
  const p = new Scripted({ extraction: () => { throw new TypeError('boom: not an LLMError'); } });
  const r = await runPipeline(allOf(p), 'Do X.', 'did X', adv);
  check('a non-LLMError exception is caught and degrades to check_incomplete rather than throwing', r.checkStatus === 'check_incomplete');
}

// ---- request-less check (CTA-only requirement) still runs the semantic layer ----
{
  const p = new Scripted({
    evaluator: (prompt: string) => {
      const idMatches = [...prompt.matchAll(/"id":"(R\d+)"/g)].map(m => m[1]);
      return { judgments: idMatches.map(id => ({ id, verdict: 'violated', category: 'omission', severity: 'warning', output_quote: '', reason: 'No call to action present.', fix: null })), unrequested: [] };
    },
    verify: () => ({ verifications: [{ cid: 'C1', request_quote: '', output_quote: '', request_means: '', output_means: '', same_subject: 'n/a', verdict: 'confirmed', fix_ok: true, better_fix: null, reason: 'ok' }] }),
    scan: { findings: [] },
  });
  const r = await runPipeline(allOf(p), '', 'Plain output with no call to action.', { ...adv, cta: true });
  check('no request text, but CTA required -> semantic review still runs on the synthetic CTA requirement', r.requirements.length === 1 && r.requirements[0].quote === '');
  check('missing CTA is caught even with an empty request box', r.findings.length === 1 && r.findings[0].category === 'omission');
}

// ---- neither request text nor any additional check requiring semantic review -> semantic layer is skipped entirely, not just fast-failed ----
{
  const r = await runPipeline({ extraction: null, evaluator: null, verifier: null }, '', 'Just some output text.', adv);
  check('empty request + no CTA: no provider needed, review is clean (deterministic-only), not incomplete', r.checkStatus === 'clean' && r.requirements.length === 0);
}

done();
}
main();
