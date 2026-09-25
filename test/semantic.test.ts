/**
 * Semantic pipeline tests, run against a scripted LLM (test/helpers.ts Scripted)
 * so every scenario is deterministic and needs no network access.
 *
 * These exercise the ARCHITECTURE described in lib/semantic.ts: the ledger,
 * the evaluator's local gating (same-subject / not-a-paraphrase), and the
 * verifier's two independent jobs (VERIFY + SCAN) and how their verdicts
 * combine into a finding's strength/verification. Most scenarios call
 * runSemanticReview directly so internal counts/failures are inspectable;
 * a few call the full runPipeline to check end-to-end status/merging.
 */
import { runSemanticReview, buildLedger } from '../lib/semantic';
import { runPipeline } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL, StageDiagnostic } from '../lib/types';
import { LLMError } from '../lib/llm/provider';
import { check, done, Scripted, allOf, ledgerFromPrompt, satisfied, notApplicable, verdictOf } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };
const run = (p: Scripted, request: string, output: string) => runSemanticReview({
  providers: allOf(p) as any, request, output, adv, t0: Date.now(), budgetMs: 60000, diagnostics: [] as StageDiagnostic[],
});
/** A ledger-driven evaluator handler: `byId` supplies a judgment per requirement id; anything unlisted is not_applicable. */
const evalByLedger = (byId: Record<string, object>, unrequested: unknown[] = []) => (prompt: string) => {
  const ledger = ledgerFromPrompt(prompt);
  return { judgments: ledger.map(l => byId[l.id] ? { id: l.id, ...byId[l.id] } : notApplicable(l.id)), unrequested };
};

async function main() {

// =====================================================================
// A. Clean output using different notation/wording for money AND a date
//    -> zero findings, full requirement coverage recorded.
// =====================================================================
{
  const REQUEST = 'Write a short paragraph. Revenue was $1.2 million in Q1 2026. The launch date is November 30, 2026. Do not mention competitors by name.';
  const OUTPUT = 'Revenue for Q1 2026 came in at $1,200,000, a solid start to the year. The launch is set for 30 November 2026.';
  const p = new Scripted({
    extraction: { items: [
      { kind: 'fact', category: 'other', text: 'Q1 2026 revenue = $1.2 million', quote: 'Revenue was $1.2 million in Q1 2026.' },
      { kind: 'fact', category: 'other', text: 'Launch date = November 30, 2026', quote: 'The launch date is November 30, 2026.' },
      { kind: 'instruction', category: 'prohibition', text: 'Must not mention competitors by name', quote: 'Do not mention competitors by name.' },
    ] },
    evaluator: (prompt: string) => {
      const ledger = ledgerFromPrompt(prompt);
      const j = ledger.map(l => {
        if (l.text.includes('revenue')) return satisfied(l.id, '$1,200,000');
        if (l.text.includes('Launch date')) return satisfied(l.id, '30 November 2026');
        if (l.category === 'prohibition') return satisfied(l.id);
        return notApplicable(l.id);          // e.g. the "Write a short paragraph." unclassified filler item
      });
      return { judgments: j, unrequested: [] };
    },
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('A: equivalent money + date notation -> zero findings', r.findings.length === 0, JSON.stringify(r.findings));
  check('A: review fully completes (no failures)', r.failures.length === 0, JSON.stringify(r.failures));
  check('A: ledger covers every requirement (no request text silently skipped)', r.requirements.length === 3 && r.requirements.every(x => x.kind !== 'unclassified' || x.quote.includes('Write a short paragraph')));
  check('A: verify was never called (nothing to verify)', p.callsFor('verify').length === 0);
}

// =====================================================================
// B. A changed number that refers to a DIFFERENT metric is not an error:
//    the evaluator's own same_subject:"no" annotation must be respected
//    and the candidate dropped locally, never even reaching the verifier.
// =====================================================================
{
  const REQUEST = 'Total Q3 revenue was $8.42 million. Total Q2 revenue was $7.92 million.';
  const OUTPUT = 'Total Q3 revenue was $8.42 million, while online sales alone were $7.92 million.';
  const p = new Scripted({
    extraction: { items: [
      { kind: 'fact', category: 'other', text: 'Q3 total revenue = $8.42 million', quote: 'Total Q3 revenue was $8.42 million.' },
      { kind: 'fact', category: 'other', text: 'Q2 total revenue = $7.92 million', quote: 'Total Q2 revenue was $7.92 million.' },
    ] },
    evaluator: (prompt: string) => {
      const ledger = ledgerFromPrompt(prompt);
      const j = ledger.map(l => l.text.includes('Q3') ? satisfied(l.id, '$8.42 million') : {
        id: l.id, verdict: 'violated', category: 'factual_contradiction', severity: 'warning',
        output_quote: '$7.92 million', same_subject: 'no', not_equivalent_because: '', reason: 'a $7.92 million figure appears, but for online sales, not Q2 revenue',
      });
      return { judgments: j, unrequested: [] };
    },
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('B: different-metric number is dropped locally, not flagged', r.findings.length === 0, JSON.stringify(r.findings));
  check('B: dropped-different-referent counter recorded', r.counts.eval_dropped_different_referent === 1);
  check('B: the dropped candidate never became a verify claim', p.callsFor('verify').length === 0);
}

// =====================================================================
// C. Real numeric contradiction, same subject: evaluator flags, verifier
//    independently confirms with its OWN grounded evidence -> "confirmed",
//    with a working targeted edit.
// =====================================================================
{
  const REQUEST = 'Total revenue for Q3 2026 was $8.42 million.';
  const OUTPUT = 'Total revenue for Q3 2026 was $3.54 million, a strong quarter.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'Q3 2026 total revenue = $8.42 million', quote: 'Total revenue for Q3 2026 was $8.42 million.' }] },
    evaluator: evalByLedger({ R1: {
      verdict: 'violated', category: 'factual_contradiction', severity: 'critical', output_quote: '$3.54 million',
      same_subject: 'yes', not_equivalent_because: 'different figure for the same metric and period', reason: 'Output states $3.54 million but the request says $8.42 million.',
      fix: { original: '$3.54 million', replacement: '$8.42 million' },
    } }),
    verify: () => ({ verifications: [verdictOf('C1', { request_quote: '$8.42 million', output_quote: '$3.54 million', reason: 'Confirmed contradiction.' })] }),
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('C: real contradiction -> exactly one confirmed finding', r.findings.length === 1 && r.findings[0].strength === 'confirmed' && r.findings[0].verification === 'confirmed', JSON.stringify(r.findings));
  check('C: finding is grounded in the REAL output text', r.findings[0].passage?.text === '$3.54 million' && r.findings[0].requirementQuote === 'Total revenue for Q3 2026 was $8.42 million.');
  check('C: targeted edit is built and anchored to the flagged passage', r.findings[0].edit?.replacement === '$8.42 million' && r.findings[0].edit?.original === '$3.54 million');
  check('C: origin is evaluator (verify confirmed directly; no scan corroboration needed)', r.findings[0].origin === 'evaluator');
}

// =====================================================================
// D. A false positive: verifier rejects it, scan does NOT independently
//    find anything wrong there -> the finding is dropped entirely.
// =====================================================================
{
  const REQUEST = 'Marketing spend was $2.87 million in Q3 2026, roughly flat year over year.';
  const OUTPUT = 'Marketing spend was about S$2.87 million in Q3 2026.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'Q3 2026 marketing spend = $2.87 million', quote: 'Marketing spend was $2.87 million in Q3 2026, roughly flat year over year.' }] },
    evaluator: evalByLedger({ R1: {
      verdict: 'violated', category: 'factual_contradiction', severity: 'warning', output_quote: 'S$2.87 million',
      same_subject: 'yes', not_equivalent_because: 'currency symbol differs', reason: 'currency mismatch', fix: null,
    } }),
    verify: () => ({ verifications: [verdictOf('C1', { verdict: 'rejected', request_quote: '$2.87 million', output_quote: 'S$2.87 million', reason: 'Same figure; only the currency notation differs. Not a real contradiction.' })] }),
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('D: verifier-rejected, uncorroborated false positive is dropped entirely', r.findings.length === 0, JSON.stringify(r.findings));
  check('D: rejection recorded internally for debugging', r.counts.eval_rejected_by_verifier === 1);
}

// =====================================================================
// E. Disagreement: verifier wrongly REJECTS a real issue, but the
//    independent scan re-finds the same passage -> not silently dropped,
//    but also not silently upgraded to "confirmed". Shown as uncertain.
// =====================================================================
{
  const REQUEST = 'The Q4 promotional plan launches on November 30, 2026.';
  const OUTPUT = 'The Q4 promotional plan launches on December 15, 2026.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'Q4 promotional plan launch date = November 30, 2026', quote: 'The Q4 promotional plan launches on November 30, 2026.' }] },
    evaluator: evalByLedger({ R1: {
      verdict: 'violated', category: 'factual_contradiction', severity: 'critical', output_quote: 'December 15, 2026',
      same_subject: 'yes', not_equivalent_because: 'different date for the same launch', reason: 'Output date does not match the request.',
      fix: { original: 'December 15, 2026', replacement: 'November 30, 2026' },
    } }),
    verify: () => ({ verifications: [verdictOf('C1', { verdict: 'rejected', request_quote: 'November 30, 2026', output_quote: 'December 15, 2026', reason: '(incorrectly) judged the dates close enough' })] }),
    scan: { findings: [{
      category: 'factual_contradiction', severity: 'critical', output_quote: 'December 15, 2026', request_quote: 'November 30, 2026',
      same_subject: 'yes', not_equivalent_because: 'different launch date than specified', reason: 'Output date does not match the request date.',
      fix: { original: 'December 15, 2026', replacement: 'November 30, 2026' },
    }] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('E: verifier reject + scan corroboration -> ONE uncertain finding (disagreement surfaced, not hidden)', r.findings.length === 1 && r.findings[0].strength === 'uncertain' && r.findings[0].verification === 'rejected_corroborated', JSON.stringify(r.findings));
  check('E: never silently upgraded to confirmed on a disputed verdict', r.findings[0].strength !== 'confirmed');
  check('E: the scan finding is folded into the evaluator finding, not duplicated', r.findings.length === 1);
}

// =====================================================================
// F. The evaluator MISSES a real prohibited-content violation entirely
//    (marks it satisfied) -> the independent SCAN still catches it.
//    Scan-only findings are always "uncertain" by design (only one
//    independent pass has seen it).
// =====================================================================
{
  const REQUEST = 'Do not mention any competitor by name.';
  const OUTPUT = 'Unlike RivalCorp, our product is better value.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'instruction', category: 'prohibition', text: 'Must not mention any competitor by name', quote: 'Do not mention any competitor by name.' }] },
    evaluator: evalByLedger({ R1: satisfied('R1') }),   // evaluator misses it
    scan: { findings: [{
      category: 'instruction_violation', severity: 'critical', output_quote: 'Unlike RivalCorp,', request_quote: 'Do not mention any competitor by name.',
      same_subject: 'n/a', not_equivalent_because: 'names a specific competitor, which is prohibited', reason: 'The output names a competitor (RivalCorp), which the request prohibits.',
      fix: { original: 'Unlike RivalCorp, ', replacement: '' },
    }] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('F: evaluator miss is still caught by the independent safety scan', r.findings.length === 1 && r.findings[0].origin === 'verifier_scan' && r.findings[0].verification === 'scan_only', JSON.stringify(r.findings));
  check('F: scan-only findings stay "uncertain" even when clearly correct (architectural, not a quality judgement)', r.findings[0].strength === 'uncertain');
  check('F: no VERIFY call was made (there was no evaluator candidate to verify)', p.callsFor('verify').length === 0);
}

// =====================================================================
// G. The evaluator call fails outright -> the verifier's safety scan
//    still has an opportunity to protect the result. The overall review
//    is still marked incomplete (an evaluator failure is real), but the
//    finding the scan caught is not thrown away.
// =====================================================================
{
  const REQUEST = 'Do not mention any competitor by name.';
  const OUTPUT = 'Unlike RivalCorp, our product is better value.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'instruction', category: 'prohibition', text: 'Must not mention any competitor by name', quote: 'Do not mention any competitor by name.' }] },
    evaluator: () => { throw new LLMError('upstream_error', 'simulated evaluator outage'); },
    scan: { findings: [{
      category: 'instruction_violation', severity: 'critical', output_quote: 'Unlike RivalCorp,', request_quote: 'Do not mention any competitor by name.',
      same_subject: 'n/a', not_equivalent_because: 'names a specific competitor', reason: 'The output names a competitor (RivalCorp).',
      fix: { original: 'Unlike RivalCorp, ', replacement: '' },
    }] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('G: evaluator outage is recorded as a failure (never silently absorbed)', r.failures.includes('upstream_error'));
  check('G: the safety scan still protected the user despite the evaluator outage', r.findings.length === 1 && r.findings[0].origin === 'verifier_scan');
  const outcome = await runPipeline(allOf(p), REQUEST, OUTPUT, adv);
  check('G (pipeline level): status is check_incomplete, NEVER "clean", despite a finding being present', outcome.checkStatus === 'check_incomplete' && outcome.findings.length === 1);
}

// =====================================================================
// H. Both verifier calls (VERIFY and SCAN) fail. A real evaluator finding
//    must NEVER be silently represented as fully verified in this case.
// =====================================================================
{
  const REQUEST = 'Total revenue for Q3 2026 was $8.42 million.';
  const OUTPUT = 'Total revenue for Q3 2026 was $3.54 million.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'Q3 2026 total revenue = $8.42 million', quote: 'Total revenue for Q3 2026 was $8.42 million.' }] },
    evaluator: evalByLedger({ R1: {
      verdict: 'violated', category: 'factual_contradiction', severity: 'critical', output_quote: '$3.54 million',
      same_subject: 'yes', not_equivalent_because: 'different figure for the same metric and period', reason: 'Mismatch.',
      fix: { original: '$3.54 million', replacement: '$8.42 million' },
    } }),
    verify: () => { throw new LLMError('timeout', 'simulated verifier timeout'); },
    scan: () => { throw new LLMError('timeout', 'simulated scan timeout'); },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('H: both verifier calls failing is recorded', r.failures.filter(f => f === 'timeout').length >= 1);
  check('H: the evaluator finding survives but is NEVER marked confirmed/verified when the verifier failed', r.findings.length === 1 && r.findings[0].strength === 'uncertain' && r.findings[0].verification === 'unverified', JSON.stringify(r.findings));
}

// =====================================================================
// I. Unsupported causal claim: caught via the "unrequested claims" path
//    (not a ledger item), and confirmed by the verifier.
// =====================================================================
{
  const REQUEST = "Summarize the campaign results. Management has not established a causal relationship between the Connected Living campaign and revenue growth.";
  const OUTPUT = 'The campaign results were strong. The Connected Living campaign drove the revenue growth this quarter.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'No established causal link between the Connected Living campaign and revenue growth', quote: 'Management has not established a causal relationship between the Connected Living campaign and revenue growth.' }] },
    evaluator: (prompt: string) => {
      const ledger = ledgerFromPrompt(prompt);
      return {
        judgments: ledger.map(l => notApplicable(l.id)),
        unrequested: [{
          output_quote: 'The Connected Living campaign drove the revenue growth this quarter.',
          request_quote: 'Management has not established a causal relationship between the Connected Living campaign and revenue growth.',
          severity: 'critical', reason: 'The request says this causal link has not been established, but the output asserts it as fact.',
          fix: { original: 'The Connected Living campaign drove the revenue growth this quarter.', replacement: 'The Connected Living campaign coincided with the revenue growth this quarter.' },
        }],
      };
    },
    verify: () => ({ verifications: [verdictOf('C1', { output_quote: 'The Connected Living campaign drove the revenue growth this quarter.', same_subject: 'n/a', reason: 'Confirmed: request denies causality; output asserts it.' })] }),
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('I: unsupported causal claim is confirmed and categorised correctly', r.findings.length === 1 && r.findings[0].category === 'unsupported_addition' && r.findings[0].strength === 'confirmed', JSON.stringify(r.findings));
  check('I: targeted edit softens the causal claim without inventing new facts', r.findings[0].edit?.replacement === 'The Connected Living campaign coincided with the revenue growth this quarter.');
}

// =====================================================================
// K. Negation error: request explicitly denies something, output asserts
//    the affirmative. Caught directly and confirmed.
// =====================================================================
{
  const REQUEST = 'No store expansion has been formally approved for Q4.';
  const OUTPUT = 'The division has approved plans to open two additional stores in Q4.';
  const p = new Scripted({
    extraction: { items: [{ kind: 'fact', category: 'other', text: 'No Q4 store expansion has been approved', quote: 'No store expansion has been formally approved for Q4.' }] },
    evaluator: evalByLedger({ R1: {
      verdict: 'violated', category: 'factual_contradiction', severity: 'critical',
      output_quote: 'The division has approved plans to open two additional stores in Q4.',
      same_subject: 'yes', not_equivalent_because: 'directly contradicts the negation in the request (approved vs. not approved)',
      reason: 'The request says no expansion has been approved; the output says the opposite.',
      fix: { original: 'The division has approved plans to open two additional stores in Q4.', replacement: 'No store expansion has been formally approved for Q4.' },
    } }),
    verify: () => ({ verifications: [verdictOf('C1', { request_quote: 'No store expansion has been formally approved for Q4.', output_quote: 'The division has approved plans to open two additional stores in Q4.', reason: 'Confirmed negation error.' })] }),
    scan: { findings: [] },
  });
  const r = await run(p, REQUEST, OUTPUT);
  check('K: negation error is caught and confirmed', r.findings.length === 1 && r.findings[0].strength === 'confirmed' && r.findings[0].category === 'factual_contradiction', JSON.stringify(r.findings));
}

// =====================================================================
// L. buildLedger is a pure function: facts and instructions keep their
//    kind, an unrecognised quote is dropped (not silently kept as text),
//    and a required CTA becomes a synthetic instruction item with no quote.
// =====================================================================
{
  const request = 'Include the loyalty programme figure. Revenue was $8.42 million.';
  const extracted = [
    { kind: 'instruction' as const, category: 'content' as const, text: 'Must include loyalty programme figure', quote: 'Include the loyalty programme figure.' },
    { kind: 'fact' as const, category: 'other' as const, text: 'Revenue = $8.42 million', quote: 'Revenue was $8.42 million.' },
    { kind: 'fact' as const, category: 'other' as const, text: 'hallucinated, not in request', quote: 'This text does not appear in the request.' },
  ];
  const { items, dropped } = buildLedger(request, extracted, true);
  check('L: instruction/fact kinds are preserved distinctly', items.some(i => i.kind === 'instruction' && i.category === 'content') && items.some(i => i.kind === 'fact'));
  check('L: a quote that is not actually in the request is dropped, not trusted', dropped === 1 && !items.some(i => i.quote.includes('does not appear')));
  check('L: CTA requirement is appended as a synthetic instruction item with no request quote', items.some(i => i.quote === '' && i.category === 'content' && /call to action/.test(i.text)));
  const { items: noCta } = buildLedger(request, extracted, false);
  check('L: CTA item is absent when not required', !noCta.some(i => /call to action/.test(i.text)));
}

// =====================================================================
// M. Pipeline-level: two related omission candidates (no passage, since
//    nothing to quote) about the SAME missing content collapse into one
//    finding instead of showing the user the same problem twice.
// =====================================================================
{
  const REQUEST = 'Cover four things: revenue, profitability, the loyalty programme, and Q4 plans. Also make sure you mention the loyalty programme membership count.';
  const OUTPUT = 'Revenue grew nicely. Profitability improved too. Q4 plans include a new store.';
  const p = new Scripted({
    extraction: { items: [
      { kind: 'instruction', category: 'content', text: 'Must cover revenue, profitability, loyalty programme, Q4 plans', quote: 'Cover four things: revenue, profitability, the loyalty programme, and Q4 plans.' },
      { kind: 'instruction', category: 'content', text: 'Must mention the loyalty programme membership count', quote: 'Also make sure you mention the loyalty programme membership count.' },
    ] },
    evaluator: evalByLedger({
      R1: { verdict: 'violated', category: 'omission', severity: 'critical', output_quote: '', reason: 'The loyalty programme is not covered.',
        fix: { original: '', insert_after: 'Q4 plans include a new store.', replacement: 'The loyalty programme grew to more than 4,820 members.' } },
      R2: { verdict: 'violated', category: 'omission', severity: 'critical', output_quote: '', reason: 'The loyalty programme membership count is missing.',
        fix: { original: '', insert_after: 'Q4 plans include a new store.', replacement: 'The loyalty programme grew to more than 4,820 members.' } },
    }),
    verify: () => ({ verifications: [
      verdictOf('C1', { request_quote: 'Cover four things: revenue, profitability, the loyalty programme, and Q4 plans.', output_quote: '', reason: 'Confirmed: loyalty programme is missing.' }),
      verdictOf('C2', { request_quote: 'Also make sure you mention the loyalty programme membership count.', output_quote: '', reason: 'Confirmed: loyalty programme membership count is missing.' }),
    ] }),
    scan: { findings: [] },
  });
  const outcome = await runPipeline(allOf(p), REQUEST, OUTPUT, adv);
  check('M: two overlapping omission candidates for the same missing content are merged into one finding', outcome.findings.length === 1, JSON.stringify(outcome.findings));
  check('M: the merged finding still carries a working suggested addition', outcome.findings[0].edit?.replacement === 'The loyalty programme grew to more than 4,820 members.');
  check('M: status reflects the confirmed omission', outcome.checkStatus === 'findings');
}

done();
}
main();
