/**
 * Review architecture tests against a scripted LLM: four parallel branches (3 reviewers + deterministic) -> flat pool -> one adjudicator.
 */
import { runReview } from '../lib/review';
import { runPipeline } from '../lib/pipeline';
import { runDeterministic } from '../lib/validators/deterministic';
import { DEFAULT_ADDITIONAL, StageDiagnostic } from '../lib/types';
import { LLMError } from '../lib/llm/provider';
import { buildDirectPrompt, buildReversePrompt, buildCoveragePrompt, buildAdjudicatorPrompt, CTA_REQUIREMENT } from '../lib/prompts';
import { check, done, Scripted, allOf, PASS, issue, issues, decision, candidatesFromPrompt, deterministicFromPrompt } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };
const run = (p: Scripted, request: string, output: string, extra: { adv?: typeof adv } = {}) => {
  const diagnostics: StageDiagnostic[] = [];
  return runReview({ providers: allOf(p), request, output, adv: extra.adv ?? adv, t0: Date.now(), budgetMs: 60000, diagnostics })
    .then(r => ({ ...r, diagnostics }));
};

const REQ = 'Total revenue for Q3 2026 was $8.42 million. Do not mention competitors.';
const OUT = 'Total revenue for Q3 2026 was $3.54 million, a strong quarter. Unlike RivalCorp, we grew.';

async function main() {

// 1. All three PASS -> nothing forwarded, adjudicator never called, review complete.
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: () => { throw new Error('must not be called'); } });
  const r = await run(p, REQ, 'Revenue was $8.42 million.');
  check('all PASS: zero findings, review complete', r.findings.length === 0 && r.failures.length === 0);
  check('all PASS: adjudicator is never called (clean outputs are cheap)', p.callsFor('adjudicator').length === 0);
  check('all PASS: exactly one call per reviewer, no retries', p.callsFor('direct').length === 1 && p.callsFor('coverage').length === 1 && p.callsFor('reverse').length === 1);
  check('all PASS: pool is empty and passes are only counted, not forwarded', r.counts.reviewer_pass === 3 && r.counts.deterministic_pass === 1 && r.counts.pool_size === 0);
}

// 2. Parallel: three 300ms reviewers finish in ~300ms, not ~900ms, and all start together.
{
  const slow = { __delay: 300, value: PASS };
  const p = new Scripted({ direct: slow, coverage: slow, reverse: slow, adjudicator: PASS });
  const t = Date.now();
  await run(p, REQ, 'x');
  const elapsed = Date.now() - t;
  const starts = ['direct', 'coverage', 'reverse'].map(s => p.callsFor(s)[0].startedAt);
  check('parallel: total time ~ max(reviewer), not the sum', elapsed < 600, `elapsed=${elapsed}ms`);
  check('parallel: all three reviewers start within a few ms of each other', Math.max(...starts) - Math.min(...starts) < 50, JSON.stringify(starts.map(s => s - starts[0])));
}

// 3. Independence: a reviewer's prompt never contains another reviewer's result or the pool.
{
  const p = new Scripted({ direct: issues(issue('instruction_violation', { reason: 'DIRECT-SECRET' })), coverage: issues(issue('omission', { reason: 'COVERAGE-SECRET' })), reverse: PASS, adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id)) }) });
  await run(p, REQ, OUT);
  const reviewerPrompts = [...p.callsFor('direct'), ...p.callsFor('coverage'), ...p.callsFor('reverse')].map(c => c.prompt);
  check('independence: no reviewer prompt contains any reviewer reason or a candidate list', reviewerPrompts.every(x => !/SECRET|--- CANDIDATES ---/.test(x)));
}

// 4. Flat pool: reviewers report DIFFERENT issues with no shared ids; all reach the adjudicator, unmatched.
{
  const p = new Scripted({
    direct: issues(issue('instruction_violation', { output_evidence: 'Unlike RivalCorp, we grew.', reason: 'd' })),
    coverage: issues(issue('factual_contradiction', { request_evidence: 'Total revenue for Q3 2026 was $8.42 million.', output_evidence: '$3.54 million', reason: 'c1' }), issue('omission', { reason: 'c2' })),
    reverse: issues(issue('unsupported_addition', { output_evidence: 'a strong quarter', reason: 'r' })),
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) }),
  });
  const r = await run(p, REQ, OUT);
  const cands = candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt);
  check('flat pool: every reviewer error reaches the adjudicator as its own candidate (E1..E4)', cands.length === 4 && cands.map(c => c.id).join() === 'E1,E2,E3,E4', JSON.stringify(cands.map(c => c.id + ':' + c.source)));
  check('flat pool: candidates keep their source reviewer, unmerged', cands.map(c => c.source).join() === 'direct,coverage,coverage,reverse');
  check('flat pool: exactly ONE adjudicator call', p.callsFor('adjudicator').length === 1);
  check('flat pool: nothing was matched or merged before adjudication (4 in the pool, 4 findings out)', r.counts.pool_size === 4 && r.findings.length === 4 && !('duplicates_consolidated' in r.counts));
}

// 5. Duplicates: three reviewers find the SAME problem; the adjudicator collapses them with duplicate_of.
{
  const same = (reason: string) => issues(issue('factual_contradiction', { request_evidence: 'Total revenue for Q3 2026 was $8.42 million.', output_evidence: '$3.54 million', reason }));
  const p = new Scripted({
    direct: same('a'), coverage: same('b'), reverse: same('c'),
    adjudicator: () => ({ decisions: [
      decision('E1', { duplicate_of: 'E2' }),
      decision('E2', { category: 'factual_contradiction', request_quote: 'Total revenue for Q3 2026 was $8.42 million.', output_quote: '$3.54 million', fix: { original: '$3.54 million', replacement: '$8.42 million' } }),
      decision('E3', { duplicate_of: 'E2' }),
    ] }),
  });
  const r = await run(p, REQ, OUT);
  check('duplicates: three identical candidates collapse into ONE confirmed finding', r.findings.length === 1 && r.findings[0].strength === 'confirmed' && r.findings[0].verification === 'adjudicated', JSON.stringify(r.findings));
  check('duplicates: the kept finding carries the kept candidate\'s origin and a validated edit', r.findings[0].origin === 'coverage' && r.findings[0].edit?.replacement === '$8.42 million');
  check('duplicates: consolidation is counted', r.counts.duplicates_consolidated === 2);
}

// 6. A duplicate pointing at a REJECTED target is not silently dropped.
{
  const p = new Scripted({
    direct: issues(issue('instruction_violation', { output_evidence: 'Unlike RivalCorp, we grew.' })), coverage: issues(issue('instruction_violation', { output_evidence: 'Unlike RivalCorp, we grew.' })), reverse: PASS,
    adjudicator: () => ({ decisions: [decision('E1', { duplicate_of: 'E2' }), { id: 'E2', verdict: 'rejected' }] }),
  });
  const r = await run(p, REQ, OUT);
  check('duplicate_of a rejected target is not honoured (it is judged on its own verdict)', r.findings.length === 1 && r.findings[0].origin === 'direct', JSON.stringify(r.findings.map(f => f.origin)));
}

// 7. The adjudicator cannot invent findings.
{
  const p = new Scripted({
    direct: PASS, coverage: issues(issue('factual_contradiction', { output_evidence: '$3.54 million', request_evidence: '$8.42 million' })), reverse: PASS,
    adjudicator: () => ({ decisions: [
      decision('E1', { category: 'factual_contradiction', output_quote: '$3.54 million', request_quote: '$8.42 million' }),
      decision('E99', { category: 'omission', reason: 'INVENTED' }),
      decision('D1', { reason: 'INVENTED-DET' }),
      decision('NEW', { reason: 'INVENTED-NEW' }),
    ] }),
  });
  const r = await run(p, REQ, OUT);
  check('adjudicator cannot create findings: only decisions for real candidate ids are used', r.findings.length === 1 && !/INVENTED/.test(JSON.stringify(r.findings)));
  check('adjudicator prompt states it is not a reviewer and lists exactly one candidate', /NOT a reviewer/.test(p.callsFor('adjudicator')[0].prompt) && candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt).length === 1);
}

// 8. Rejection of a false positive.
{
  const p = new Scripted({ direct: PASS, coverage: issues(issue('factual_contradiction', { output_evidence: '$3.54 million' })), reverse: PASS, adjudicator: () => ({ decisions: [{ id: 'E1', verdict: 'rejected' }] }) });
  const r = await run(p, REQ, OUT);
  check('false positive rejected by the adjudicator -> no finding, review complete', r.findings.length === 0 && r.failures.length === 0 && r.counts.adjudicator_rejected === 1);
}

// 9. One reviewer fails: the others' candidates survive; only that failure is recorded.
{
  const p = new Scripted({
    direct: issues(issue('instruction_violation', { output_evidence: 'Unlike RivalCorp, we grew.', request_evidence: 'Do not mention competitors.' })),
    coverage: PASS, reverse: () => { throw new LLMError('timeout', 'simulated'); },
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) }),
  });
  const r = await run(p, REQ, OUT);
  check('one reviewer timeout: the other reviewers\' finding is kept and adjudicated', r.findings.length === 1 && r.findings[0].strength === 'confirmed');
  check('one reviewer timeout: failure recorded (review incomplete) without failing the rest', r.failures.join() === 'timeout');
  const byStage = Object.fromEntries(r.diagnostics.map(d => [d.stage, d.ok]));
  check('one reviewer timeout: diagnostics show reverse failed while direct/coverage/adjudicator succeeded', byStage.reverse === false && byStage.direct === true && byStage.coverage === true && byStage.adjudicator === true, JSON.stringify(byStage));
}

// 10. Adjudicator fails: candidates survive as uncertain/unadjudicated; identical ones do not multiply.
{
  const same = issues(issue('factual_contradiction', { request_evidence: 'Total revenue for Q3 2026 was $8.42 million.', output_evidence: '$3.54 million' }));
  const other = issues(issue('instruction_violation', { request_evidence: 'Do not mention competitors.', output_evidence: 'Unlike RivalCorp, we grew.' }));
  const p = new Scripted({ direct: same, coverage: { ...same, issues: [...same.issues, ...other.issues] }, reverse: same, adjudicator: () => { throw new LLMError('upstream_error', 'down'); } });
  const r = await run(p, REQ, OUT);
  check('adjudicator failure: 4 raw candidates become 2 findings (exact-span dedup, no LLM)', r.findings.length === 2, JSON.stringify(r.findings.map(f => f.passage?.text)));
  check('adjudicator failure: every finding is uncertain + unadjudicated (no fabricated certainty)', r.findings.every(f => f.strength === 'uncertain' && f.verification === 'unadjudicated'));
  check('adjudicator failure: failure recorded, dedup counted', r.failures.includes('upstream_error') && r.counts.unadjudicated_deduped === 2);
  check('adjudicator failure: no model-proposed edit is applied without a decision', r.findings.every(f => f.edit === null));
}

// 11. Evidence grounding: fabricated quotes never reach the user.
{
  const p = new Scripted({
    direct: PASS, coverage: issues(issue('factual_contradiction', { output_evidence: 'this sentence is not in the output', request_evidence: 'nor is this in the request' })), reverse: PASS,
    adjudicator: () => ({ decisions: [decision('E1', { output_quote: 'also fabricated', request_quote: 'also fabricated', fix: { original: 'also fabricated', replacement: 'x' } })] }),
  });
  const r = await run(p, REQ, OUT);
  check('fabricated evidence: never shown and never "confirmed"', r.findings.length === 1 && r.findings[0].strength === 'uncertain' && r.findings[0].passage === null && r.findings[0].requirementQuote === null);
  check('fabricated evidence: a fix built on a non-existent span is refused', r.findings[0].edit === null);
  const q = new Scripted({ direct: PASS, coverage: issues(issue('factual_contradiction', { output_evidence: 'total  REVENUE for q3 2026 was $3.54 million' })), reverse: PASS, adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type })) }) });
  const r2 = await run(q, REQ, OUT);
  check('grounding: whitespace/case drift is sliced from the REAL text, never the model copy', r2.findings[0].passage?.text === 'Total revenue for Q3 2026 was $3.54 million', JSON.stringify(r2.findings[0].passage));
}

// 12. unsupported_causal_claim is a first-class category end to end.
{
  const REQC = 'Summarize. Management has not established a causal relationship between the campaign and revenue growth.';
  const OUTC = 'Results were strong. The campaign drove the revenue growth this quarter.';
  const p = new Scripted({
    direct: PASS, coverage: PASS,
    reverse: issues(issue('unsupported_causal_claim', { request_evidence: 'Management has not established a causal relationship between the campaign and revenue growth.', output_evidence: 'The campaign drove the revenue growth this quarter.' })),
    adjudicator: () => ({ decisions: [decision('E1', { category: 'unsupported_causal_claim', request_quote: 'Management has not established a causal relationship between the campaign and revenue growth.', output_quote: 'The campaign drove the revenue growth this quarter.', fix: { original: 'drove', replacement: 'coincided with' } })] }),
  });
  const r = await run(p, REQC, OUTC);
  check('unsupported_causal_claim: accepted from a reviewer and from the adjudicator, confirmed', r.findings.length === 1 && r.findings[0].category === 'unsupported_causal_claim' && r.findings[0].strength === 'confirmed');
  check('unsupported_causal_claim: fix must touch the flagged passage and is validated', r.findings[0].edit?.original === 'drove' && r.findings[0].edit?.replacement === 'coincided with');
  check('unsupported_causal_claim: reverse-check output reaches the adjudicator (source recorded)', candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt)[0].source === 'reverse');
}

// 13. Omission anchors.
{
  const REQO = 'Cover revenue and the loyalty programme.';
  const OUTO = 'Revenue grew. Margins rose.';
  const mk = (anchor: string) => new Scripted({
    direct: PASS, reverse: PASS,
    coverage: issues(issue('omission', { request_evidence: 'Cover revenue and the loyalty programme.', reason: 'loyalty missing' })),
    adjudicator: () => ({ decisions: [decision('E1', { category: 'omission', request_quote: 'Cover revenue and the loyalty programme.', fix: { insert_after: anchor, replacement: 'The loyalty programme grew.' } })] }),
  });
  const r = await run(mk('Margins rose.'), REQO, OUTO);
  check('omission: insertion edit anchored on an exact, unique OUTPUT sentence', r.findings[0].edit?.start === OUTO.length && r.findings[0].edit?.replacement === ' The loyalty programme grew.' && r.findings[0].strength === 'confirmed');
  const r2 = await run(mk('Not a sentence in the output.'), REQO, OUTO);
  check('omission: an anchor that does not exist yields advice only, no edit', r2.findings[0].edit === null && r2.findings[0].suggestion === 'The loyalty programme grew.');
  const r3 = await run(mk('Revenue grew.'), REQO, 'Revenue grew. Revenue grew. Done.');
  check('omission: an ambiguous (repeated) anchor yields no edit', r3.findings[0].edit === null);
}

// 14. CTA-only run: only Coverage Trace runs; the omission is grounded to the user setting.
{
  const p = new Scripted({
    coverage: issues(issue('omission', { request_evidence: CTA_REQUIREMENT, reason: 'no call to action' })),
    direct: () => { throw new Error('must not run'); }, reverse: () => { throw new Error('must not run'); },
    adjudicator: () => ({ decisions: [decision('E1', { category: 'omission', request_quote: CTA_REQUIREMENT })] }),
  });
  const r = await run(p, '', 'Plain output with no call to action.', { adv: { ...adv, cta: true } });
  check('CTA-only: Direct Match and Reverse Check are not called (nothing to compare)', p.callsFor('direct').length === 0 && p.callsFor('reverse').length === 0 && p.callsFor('coverage').length === 1);
  check('CTA-only: missing CTA is a confirmed omission grounded to the setting sentence', r.findings.length === 1 && r.findings[0].category === 'omission' && r.findings[0].requirementQuote === CTA_REQUIREMENT && r.findings[0].strength === 'confirmed');
  check('CTA-only: the coverage prompt carries the exact setting sentence', /USER SETTING/.test(p.callsFor('coverage')[0].prompt));
}

// 15. Deterministic failures join the pool but are not re-judged.
{
  const advD = { ...adv, forbiddenTerms: true, forbiddenTermsVal: 'RivalCorp' };
  const det = runDeterministic(OUT, advD);
  check('deterministic: exact forbidden-term check fires in code with an exact span and edit', det.findings.length === 1 && det.findings[0].passage?.text === 'RivalCorp' && det.findings[0].edit?.replacement === '');
  const p = new Scripted({
    direct: PASS, reverse: PASS,
    coverage: issues(issue('instruction_violation', { request_evidence: 'Do not mention competitors.', output_evidence: 'RivalCorp' })),
    adjudicator: () => ({ decisions: [decision('E1', { duplicate_of: 'D1' })] }),
  });
  const r = await runPipeline(allOf(p), REQ, OUT, advD);
  const ctx = deterministicFromPrompt(p.callsFor('adjudicator')[0].prompt);
  check('deterministic: the adjudicator sees the proven failure as context (D1), not as a candidate', /"id":"D1"/.test(ctx) && !candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt).some(c => c.id === 'D1'));
  check('deterministic: a semantic duplicate of a proven failure collapses; the deterministic finding survives with its edit', r.findings.length === 1 && r.findings[0].origin === 'deterministic' && r.findings[0].strength === 'confirmed' && r.findings[0].edit !== null);
}
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: () => { throw new Error('must not be called'); } });
  const r = await runPipeline(allOf(p), REQ, 'Revenue $8.42 million.', { ...adv, maxWords: true, maxWordsVal: 1 });
  check('deterministic-only failure: preserved as a confirmed structural finding, adjudicator not called', r.findings.length === 1 && r.findings[0].category === 'structural' && r.findings[0].strength === 'confirmed' && p.callsFor('adjudicator').length === 0 && r.checkStatus === 'findings');
}

// 16. Prompts: Direct Match / Reverse Check are genuinely different tasks.
{
  const d = buildDirectPrompt('REQ-TEXT', 'OUT-TEXT'), rv = buildReversePrompt('REQ-TEXT', 'OUT-TEXT'), cv = buildCoveragePrompt('REQ-TEXT', 'OUT-TEXT', { wordCount: 1, listItems: 0 }, false);
  check('direct prompt: contextual-intent examples (trip pass / lunch mismatch) and no "every sentence is a requirement"', /enjoy your trip/.test(d) && /How was your lunch/.test(d) && /do not turn each sentence of the REQUEST into a requirement/.test(d));
  check('reverse prompt: OUTPUT is presented BEFORE the REQUEST and inferred_task comes first in the response shape', rv.lastIndexOf('--- OUTPUT ---') < rv.lastIndexOf('--- REQUEST ---') && /"inferred_task":"\.\.\.","status"/.test(rv));
  check('direct/coverage prompts present REQUEST first (forward read); reverse does not', d.indexOf('--- REQUEST ---') < d.indexOf('--- OUTPUT ---') && cv.indexOf('--- REQUEST ---') < cv.indexOf('--- OUTPUT ---'));
  check('coverage prompt is handed measured counts so the model never counts', /has 1 words and 0 list items/.test(cv));
  const DEFS = /\(breaks\/ignores|\(states something different|\(asserts a|\(requested\/required content/;
  check('reviewer prompts carry no category definitions (they only label); the adjudicator, which classifies, does', !DEFS.test(d) && !DEFS.test(rv) && !DEFS.test(cv) && DEFS.test(buildAdjudicatorPrompt([], [], 'R', 'O', { wordCount: 1, listItems: 0 })));
  check('reviewer prompts are compact: under 2 KB of fixed instruction text each', [buildDirectPrompt('', ''), buildCoveragePrompt('', '', { wordCount: 0, listItems: 0 }, false), buildReversePrompt('', '')].every(x => x.length < 2000));
  check('the three reviewer prompts are distinct tasks', new Set([d.slice(0, 80), rv.slice(0, 80), cv.slice(0, 80)]).size === 3);
  const p = new Scripted({
    direct: PASS, coverage: PASS,
    reverse: { inferred_task: 'Explains exchange application deadlines', status: 'issues', issues: [issue('instruction_violation', { output_evidence: 'Unlike RivalCorp, we grew.', reason: 'wrong task' })] },
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id)) }),
  });
  await run(p, REQ, OUT);
  check('reverse: inferred_task is forwarded to the adjudicator as context', candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt)[0].output_answers === 'Explains exchange application deadlines');
}

// 17. Diagnostics for latency analysis.
{
  const p = new Scripted({ direct: PASS, coverage: issues(issue('omission', { request_evidence: 'Do not mention competitors.' })), reverse: PASS, adjudicator: () => ({ decisions: [{ id: 'E1', verdict: 'rejected' }] }) });
  const r = await run(p, REQ, OUT);
  check('diagnostics: every model stage records model, prompt size, max tokens, timeout and latency', r.diagnostics.length === 5 && r.diagnostics.filter(d => d.stage !== 'deterministic').every(d => d.model === 'scripted-model' && d.promptChars > 100 && d.maxTokens > 0 && d.timeoutMs > 0 && d.ms >= 0 && typeof d.ok === 'boolean'), JSON.stringify(r.diagnostics));
  const detDiag = r.diagnostics.find(d => d.stage === 'deterministic')!;
  check('diagnostics: the deterministic branch is recorded too (no model, no prompt), so max(det, direct, coverage, reverse) is observable', !!detDiag && detDiag.ok && detDiag.promptChars === 0 && detDiag.maxTokens === 0 && !detDiag.model);
  const adj = r.diagnostics.find(d => d.stage === 'adjudicator')!, dir = r.diagnostics.find(d => d.stage === 'direct')!;
  check('diagnostics: the adjudicator prompt is larger than a reviewer prompt (it also carries the candidates)', adj.promptChars > dir.promptChars);
}

// 18. Unknown reviewer type does not lose a real candidate.
{
  const p = new Scripted({ direct: PASS, coverage: issues({ type: 'weird_type', request_evidence: '', output_evidence: 'Unlike RivalCorp, we grew.', reason: 'x' }), reverse: PASS, adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { output_quote: c.output_evidence })) }) });
  const r = await run(p, REQ, OUT);
  check('unknown reviewer type is defaulted, the candidate is kept for the adjudicator', r.findings.length === 1 && r.findings[0].category === 'instruction_violation');
}

// 19. Deterministic checks are a FOURTH PARALLEL BRANCH, never a gate in front of the reviewers.
{
  const advD = { ...adv, maxWords: true, maxWordsVal: 1 };
  const slow = { __delay: 300, value: PASS };
  const p = new Scripted({ direct: slow, coverage: slow, reverse: slow, adjudicator: () => { throw new Error('must not be called'); } });
  const t = Date.now();
  const r = await run(p, REQ, OUT, { adv: advD });
  const elapsed = Date.now() - t;
  const starts = ['direct', 'coverage', 'reverse'].map(s => p.callsFor(s)[0].startedAt);
  const detDiag = r.diagnostics.find(d => d.stage === 'deterministic')!;
  check('deterministic branch: a deterministic FAILURE does not stop or delay the reviewers (all three still start together)', Math.max(...starts) - Math.min(...starts) < 50 && p.calls.length === 3);
  check('deterministic branch: total time is the slowest branch (~300ms), not deterministic + reviewers', elapsed < 600 && detDiag.ms < 100, `elapsed=${elapsed} det=${detDiag.ms}`);
  check('deterministic branch: its failure is in the pool, final, and needs no adjudication (reviewers all PASSed)', r.findings.length === 1 && r.findings[0].origin === 'deterministic' && r.findings[0].strength === 'confirmed' && r.counts.pool_size === 1 && p.callsFor('adjudicator').length === 0);
  check('deterministic branch: reviewer prompts never contain the deterministic result', [...p.callsFor('direct'), ...p.callsFor('coverage'), ...p.callsFor('reverse')].every(c => !/word limit|over the 1-word/.test(c.prompt)));
}

// 20. A crash inside the deterministic branch is isolated: reviewers' work survives, review is incomplete.
{
  const broken = { ...adv, requiredTerms: true, requiredTermsVal: undefined as unknown as string };   // makes runDeterministic throw
  const p = new Scripted({
    direct: PASS, reverse: PASS, coverage: issues(issue('instruction_violation', { request_evidence: 'Do not mention competitors.', output_evidence: 'Unlike RivalCorp, we grew.' })),
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) }),
  });
  const r = await run(p, REQ, OUT, { adv: broken });
  const detDiag = r.diagnostics.find(d => d.stage === 'deterministic')!;
  check('deterministic crash: reviewers are unaffected and their finding is adjudicated', r.findings.length === 1 && r.findings[0].strength === 'confirmed' && r.findings[0].origin === 'coverage');
  check('deterministic crash: recorded as a failure (incomplete), not silently treated as a pass', r.failures.includes('deterministic_error') && detDiag.ok === false && !('deterministic_pass' in r.counts));
}

// 21. A clean result is cheap: every branch PASSes -> no adjudicator and no model call beyond the three reviewers.
{
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: () => { throw new Error('must not be called'); } });
  const r = await run(p, REQ, 'Revenue was $8.42 million.');
  check('clean: four branches PASS -> exactly three model calls (one per reviewer), no adjudicator', p.calls.length === 3 && r.findings.length === 0 && r.failures.length === 0 && r.counts.pool_size === 0);
}

// 22. A deterministic failure plus a reviewer error: ONE adjudicator call; it sees D1 as context only.
{
  const advD = { ...adv, forbiddenTerms: true, forbiddenTermsVal: 'RivalCorp' };
  const p = new Scripted({
    direct: PASS, reverse: PASS,
    coverage: issues(issue('factual_contradiction', { request_evidence: 'Total revenue for Q3 2026 was $8.42 million.', output_evidence: '$3.54 million' })),
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) }),
  });
  const r = await run(p, REQ, OUT, { adv: advD });
  const cands = candidatesFromPrompt(p.callsFor('adjudicator')[0].prompt);
  check('deterministic + reviewer error: one adjudicator call, candidates are E-ids only, D1 is context', p.callsFor('adjudicator').length === 1 && cands.every(c => c.id.startsWith('E')) && /"id":"D1"/.test(deterministicFromPrompt(p.callsFor('adjudicator')[0].prompt)));
  check('deterministic + reviewer error: both findings survive independently (not the same issue)', r.findings.length === 2 && r.findings.some(f => f.origin === 'deterministic') && r.findings.some(f => f.origin === 'coverage'));
}

done();
}
main();
