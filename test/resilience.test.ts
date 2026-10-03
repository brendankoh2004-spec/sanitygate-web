/**
 * Failure handling: every failure degrades to an honest "incomplete" and never to "clean";
 * one reviewer failing never erases the others' work; no model call is made when the budget is gone.
 */
import { runPipeline } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { LLMError } from '../lib/llm/provider';
import { check, done, Scripted, allOf, NO_PROVIDERS, PASS, issue, issues, decision, candidatesFromPrompt } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };
const REQ = 'Do not mention competitors. Management has not approved any store expansion.';
const OUT = 'We are opening two stores. Unlike RivalCorp, we grew.';
const confirmAll = (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) });
const found = issues(issue('instruction_violation', { request_evidence: 'Do not mention competitors.', output_evidence: 'Unlike RivalCorp, we grew.' }));

async function main() {
{
  const r = await runPipeline(NO_PROVIDERS, REQ, OUT, adv);
  check('no provider configured -> check_incomplete, never clean', r.checkStatus === 'check_incomplete' && r.semanticError === 'unavailable' && r.incompleteReason === 'general');
  check('no provider configured: deterministic still ran, and each missing role failed on its own', r.diagnostics.stages.some(s => s.stage === 'deterministic' && s.ok) && r.diagnostics.stages.filter(s => s.code === 'unavailable').length === 3);
}
{
  const r = await runPipeline(NO_PROVIDERS, '', 'plain text', adv);
  check('no request and no CTA -> only the deterministic branch runs; clean without any provider', r.checkStatus === 'clean' && r.diagnostics.stages.length === 1 && r.diagnostics.stages[0].stage === 'deterministic');
}
for (const who of ['direct', 'coverage', 'reverse'] as const) {
  const handlers: any = { direct: PASS, coverage: PASS, reverse: PASS, adjudicator: confirmAll };
  handlers[who] = () => { throw new LLMError('rate_limited', 'x'); };
  const other = who === 'direct' ? 'coverage' : 'direct';
  handlers[other] = found;
  const p = new Scripted(handlers);
  const r = await runPipeline(allOf(p), REQ, OUT, adv);
  check(`${who} rate-limited: the other reviewer's finding survives and is adjudicated`, r.findings.length === 1 && r.findings[0].strength === 'confirmed');
  check(`${who} rate-limited: status is check_incomplete (never clean/findings) with reason "busy"`, r.checkStatus === 'check_incomplete' && r.incompleteReason === 'busy');
}
{
  const failing = new Scripted({ direct: () => { throw new LLMError('timeout', 'x'); }, coverage: () => { throw new LLMError('timeout', 'x'); }, reverse: () => { throw new LLMError('timeout', 'x'); }, adjudicator: PASS });
  const r = await runPipeline(allOf(failing), REQ, OUT, adv);
  check('all three reviewers time out: incomplete/timeout, zero findings fabricated, adjudicator never called', r.checkStatus === 'check_incomplete' && r.incompleteReason === 'timeout' && r.findings.length === 0 && failing.callsFor('adjudicator').length === 0);
  check('timeouts are not retried (one attempt each)', ['direct', 'coverage', 'reverse'].every(s => failing.callsFor(s).length === 1));
}
{
  const p = new Scripted({ direct: [{ notAnObject: true }, found], coverage: PASS, reverse: PASS, adjudicator: confirmAll });
  const r = await runPipeline(allOf(p), REQ, OUT, adv);
  check('invalid_response is retried once and recovers', p.callsFor('direct').length === 2 && r.findings.length === 1 && r.checkStatus === 'findings');
}
{
  const p = new Scripted({ direct: { __partial: true, value: found }, coverage: PASS, reverse: PASS, adjudicator: confirmAll });
  const r = await runPipeline(allOf(p), REQ, OUT, adv);
  check('a truncated reviewer response keeps its salvaged candidate but marks the review incomplete', r.findings.length === 1 && r.checkStatus === 'check_incomplete');
}
{
  const p = new Scripted({ direct: found, coverage: found, reverse: PASS, adjudicator: () => ({ decisions: [decision('E1', { category: 'instruction_violation', output_quote: 'Unlike RivalCorp, we grew.', request_quote: 'Do not mention competitors.' })] }) });
  const r = await runPipeline(allOf(p), REQ, OUT, adv);
  check('adjudicator answers only one of two candidates: incomplete, and the undecided duplicate of an adjudicated finding does not resurface', r.checkStatus === 'check_incomplete' && r.findings.length === 1 && r.findings[0].verification === 'adjudicated' && p.callsFor('adjudicator').length === 2, JSON.stringify(r.findings.map(f => f.verification)));
}
{
  const p = new Scripted({ direct: found, coverage: PASS, reverse: PASS, adjudicator: () => { throw new LLMError('rate_limited', 'x'); } });
  const r = await runPipeline(allOf(p), REQ, OUT, adv);
  check('adjudicator rate-limited: finding kept as uncertain, status incomplete/busy', r.findings.length === 1 && r.findings[0].strength === 'uncertain' && r.findings[0].verification === 'unadjudicated' && r.checkStatus === 'check_incomplete' && r.incompleteReason === 'busy');
}
{
  const prev = process.env.PIPELINE_BUDGET_MS; process.env.PIPELINE_BUDGET_MS = '0';
  try {
    const p = new Scripted({ direct: found, coverage: found, reverse: found, adjudicator: confirmAll });
    const r = await runPipeline(allOf(p), REQ, OUT, adv);
    check('exhausted budget: NO model call is attempted', p.calls.length === 0);
    check('exhausted budget: degrades to check_incomplete/timeout, no fabricated findings', r.checkStatus === 'check_incomplete' && r.incompleteReason === 'timeout' && r.findings.length === 0);
  } finally { if (prev === undefined) delete process.env.PIPELINE_BUDGET_MS; else process.env.PIPELINE_BUDGET_MS = prev; }
}
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: PASS });
  const boom = { get direct(): never { throw new Error('boom'); }, coverage: p, reverse: p, adjudicator: p };
  const r = await runPipeline(boom as any, REQ, OUT, adv);
  check('an unexpected internal error degrades to check_incomplete and never looks clean', r.checkStatus === 'check_incomplete' && r.semanticError === 'internal_error' && r.findings.length === 0);
}
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: PASS });
  const r = await runPipeline(allOf(p), REQ, OUT, adv, { onStage: s => { if (s === 'reviewing') throw new Error('hook bug'); } });
  check('a throwing progress hook can never break a check', r.checkStatus === 'clean' && r.semanticError === null);
}
for (const who of ['direct', 'coverage', 'reverse'] as const) {
  const handlers: any = { direct: PASS, coverage: PASS, reverse: PASS, adjudicator: confirmAll };
  handlers[who === 'direct' ? 'coverage' : 'direct'] = found;
  const p = new Scripted(handlers);
  const providers = { ...allOf(p), [who]: null };
  const r = await runPipeline(providers, REQ, OUT, adv);
  check(`${who} role has no provider: only that branch fails (unavailable); the other reviewers' finding survives`, r.findings.length === 1 && r.findings[0].strength === 'confirmed' && r.semanticError === 'unavailable' && r.checkStatus === 'check_incomplete' && p.callsFor(who).length === 0);
}
{
  const p = new Scripted({ direct: found, coverage: PASS, reverse: PASS, adjudicator: confirmAll });
  const r = await runPipeline({ ...allOf(p), adjudicator: null }, REQ, OUT, adv);
  check('adjudicator role has no provider: candidates survive as uncertain/unadjudicated, check incomplete', r.findings.length === 1 && r.findings[0].strength === 'uncertain' && r.findings[0].verification === 'unadjudicated' && r.checkStatus === 'check_incomplete' && r.semanticError === 'unavailable');
}
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: PASS });
  const r = await runPipeline(allOf(p), REQ, 'Short', { ...adv, maxWords: true, maxWordsVal: 0 });
  check('a deterministic failure is preserved even when every semantic reviewer passes', r.findings.length === 1 && r.findings[0].origin === 'deterministic' && r.checkStatus === 'findings');
}
done();
}
main();
