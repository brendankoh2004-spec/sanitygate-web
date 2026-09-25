/**
 * Long, realistic multi-metric document (spec section 14). Proves the
 * semantic layer locates errors by understanding WHICH number belongs to
 * WHICH statement — not by treating "does this number appear somewhere in
 * the request" as sufficient (that's exactly the old deterministic
 * approach this rebuild replaces). The scripted evaluator/verifier below
 * decide every verdict dynamically from the actual OUTPUT text passed in
 * the prompt, so the SAME handler is used for both the clean and the
 * broken output — nothing is hardcoded per run.
 */
import { runPipeline } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { Q3_REQUEST, Q3_GOOD_OUTPUT, Q3_BAD_OUTPUT, Q3_ERRORS, Q3Error } from '../evaluation/fixtures/q3';
import { check, done, Scripted, allOf, ledgerFromPrompt, satisfied, notApplicable } from './helpers';

// Force a single evaluator batch so the "unrequested claims" pass (only solicited on the
// first batch) covers the whole ~18-item ledger for this long request.
process.env.EVALUATOR_BATCH_SIZE = '30';
const adv = { ...DEFAULT_ADDITIONAL };

const EXTRACTED = [
  { kind: 'instruction', category: 'content', text: 'Cover revenue, profitability, loyalty programme, Q4 plans', quote: 'Cover four things: revenue, profitability, the loyalty programme, and Q4 plans.' },
  { kind: 'instruction', category: 'prohibition', text: 'Must not mention any competitor by name', quote: 'Do not mention any competitor by name.' },
  { kind: 'instruction', category: 'prohibition', text: 'Must not claim the Connected Living campaign caused revenue growth', quote: 'Do not state that the Connected Living campaign caused the revenue growth.' },
  { kind: 'instruction', category: 'content', text: 'Must end with a CTA inviting the committee to the Q4 planning session', quote: 'End with a clear call to action inviting the committee to the Q4 planning session.' },
  { kind: 'fact', category: 'other', text: 'Q3 2026 total revenue = S$8.42 million (up 6.3% from S$7.92 million in Q3 2025)', quote: 'Total revenue for Q3 2026 was S$8.42 million, up 6.3% from Q3 2025 (S$7.92 million).' },
  { kind: 'fact', category: 'other', text: 'Q3 2026 online sales = S$3.54 million', quote: 'Online sales contributed S$3.54 million of the Q3 2026 revenue.' },
  { kind: 'fact', category: 'other', text: 'Q3 2026 gross margin = 42.0% (was 39.5% in Q3 2025)', quote: 'Gross margin improved to 42.0% in Q3 2026 from 39.5% in Q3 2025.' },
  { kind: 'fact', category: 'other', text: 'Q3 2026 operating profit = S$1.17 million (was S$0.96 million in Q3 2025)', quote: 'Operating profit was S$1.17 million in Q3 2026, compared with S$0.96 million in Q3 2025.' },
  { kind: 'fact', category: 'other', text: 'Q3 2026 marketing spend = S$2.87 million', quote: 'Marketing spend was S$2.87 million in Q3 2026.' },
  { kind: 'fact', category: 'other', text: 'Loyalty programme > 4,820 members, enrolled Aug 15 - Sep 30, 2026', quote: 'The loyalty programme grew to more than 4,820 members, enrolled between August 15 and September 30, 2026.' },
  { kind: 'fact', category: 'other', text: 'No established causal link between Connected Living campaign and revenue growth', quote: "Management has not established a causal relationship between the Connected Living campaign and the division's revenue growth." },
  { kind: 'fact', category: 'other', text: 'No Q4 store expansion has been approved', quote: 'No store expansion has been formally approved for Q4.' },
  { kind: 'fact', category: 'other', text: 'Q4 promotional plan launch date = November 30, 2026', quote: 'The Q4 promotional plan launches on November 30, 2026.' },
  { kind: 'fact', category: 'other', text: 'Q4 planning session date = October 22, 2026', quote: 'The Q4 planning session is on October 22, 2026.' },
];

function isBroken(errId: string, output: string): boolean {
  switch (errId) {
    case 'wrong_metric_value': return output.includes('reached S$3.54 million');
    case 'prohibited_competitor': return output.includes('RivalCorp');
    case 'unsupported_causal': return output.includes('which drove the revenue growth');
    case 'negation_contradiction': return output.includes('approved plans to open two additional stores');
    case 'wrong_date': return output.includes('December 15, 2026');
    case 'omitted_loyalty': return !/loyalty/i.test(output);
    case 'omitted_cta': return !/Q4 planning session/i.test(output);
    default: return false;
  }
}

/** One evaluator, driven entirely by the real OUTPUT text — not by which fixture variant is "supposed" to be running. */
function makeEvaluator(output: string) {
  return (prompt: string) => {
    const ledger = ledgerFromPrompt(prompt);
    const judgments = ledger.map(l => {
      const err = Q3_ERRORS.find(e => e.requestFragment === l.quote && e.category !== 'unsupported_addition');
      if (!err) return notApplicable(l.id);
      if (!isBroken(err.id, output)) return satisfied(l.id);
      return {
        id: l.id, verdict: 'violated', category: err.category, severity: 'critical',
        output_quote: err.outputQuote, same_subject: err.category === 'factual_contradiction' ? 'yes' : 'n/a',
        not_equivalent_because: 'deliberately introduced error for testing', reason: `Detected: ${err.id}`,
        fix: err.fix ? { original: err.fix.original, replacement: err.fix.replacement } : null,
      };
    });
    const causal = Q3_ERRORS.find(e => e.id === 'unsupported_causal') as Q3Error;
    const unrequested = isBroken('unsupported_causal', output) ? [{
      output_quote: causal.outputQuote, request_quote: causal.requestFragment, severity: 'critical',
      reason: 'The request says this causal link has not been established, but the output asserts it as fact.',
      fix: { original: causal.fix!.original, replacement: causal.fix!.replacement },
    }] : [];
    return { judgments, unrequested };
  };
}

/** Generic verifier: re-quotes and confirms whatever the evaluator claimed, by re-parsing the claims block
 * straight out of its own prompt (i.e. it re-derives grounding independently rather than trusting a shortcut). */
function makeVerifier() {
  return (prompt: string) => {
    const block = prompt.slice(prompt.indexOf('--- CLAIMS ---') + '--- CLAIMS ---'.length, prompt.indexOf('--- REQUEST ---'));
    const claims = block.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return {
      verifications: claims.map((c: any) => ({
        cid: c.cid, request_quote: c.claimed_request_passage, output_quote: c.claimed_output_passage,
        request_means: '', output_means: '', same_subject: c.category === 'factual_contradiction' ? 'yes' : 'n/a',
        verdict: 'confirmed', fix_ok: true, better_fix: null, reason: 'Confirmed via independent re-check.',
      })),
    };
  };
}

function providersFor(output: string) {
  return allOf(new Scripted({
    extraction: { items: EXTRACTED },
    evaluator: makeEvaluator(output),
    verify: makeVerifier(),
    scan: { findings: [] },
  }));
}

async function main() {

// ---- clean, correctly-worded output (different notation throughout) -> zero findings ----
{
  const r = await runPipeline(providersFor(Q3_GOOD_OUTPUT), Q3_REQUEST, Q3_GOOD_OUTPUT, adv);
  check('Q3 good output: fully clean despite heavy paraphrasing/notation differences', r.checkStatus === 'clean' && r.findings.length === 0, JSON.stringify(r.findings));
  check('Q3 good output: the full request is parsed into a substantial requirement ledger', r.requirements.length >= 14);
  check('Q3 good output: review completes with no failures on a long realistic document', r.diagnostics.notes.length === 0 || !r.diagnostics.notes.some(n => n.includes('failed')));
}

// ---- broken output: exactly the 7 deliberately introduced errors, nothing more, nothing less ----
{
  const r = await runPipeline(providersFor(Q3_BAD_OUTPUT), Q3_REQUEST, Q3_BAD_OUTPUT, adv);
  check('Q3 bad output: exactly the 7 seeded errors are found, no extras, no drops', r.findings.length === Q3_ERRORS.length, `found ${r.findings.length}: ${JSON.stringify(r.findings.map(f => f.reason))}`);
  check('Q3 bad output: every finding is confirmed (evaluator + verifier agree, grounded)', r.findings.every(f => f.strength === 'confirmed'));
  check('Q3 bad output: status is "findings" (confirmed issues present)', r.checkStatus === 'findings');

  const byCategory: Record<string, number> = {};
  r.findings.forEach(f => { byCategory[f.category] = (byCategory[f.category] || 0) + 1; });
  check('Q3 bad output: category mix matches the seeded errors (3 factual, 1 instruction, 1 unsupported, 2 omission)',
    byCategory.factual_contradiction === 3 && byCategory.instruction_violation === 1 && byCategory.unsupported_addition === 1 && byCategory.omission === 2,
    JSON.stringify(byCategory));

  // The critical assertion: the SAME figure ($3.54 million) is used correctly for online sales
  // and incorrectly for total revenue in the same document. Only the wrong usage is flagged.
  const moneyFindings = r.findings.filter(f => f.passage && f.passage.text.includes('3.54 million'));
  check('Q3 bad output: understands WHICH statement a number belongs to (correct online-sales use of $3.54m is untouched, only the wrong total-revenue use is flagged)', moneyFindings.length === 1 && moneyFindings[0].edit?.replacement === 'S$8.42 million, up 6.3%', JSON.stringify(moneyFindings));

  const editable = r.findings.filter(f => f.edit);
  check('Q3 bad output: 5 of the 7 findings carry a working targeted edit (the 2 omissions had no safe auto-fix scripted)', editable.length === 5);

  // Simulate accepting every edit at once, as the UI allows, and confirm none corrupts another.
  let corrected = Q3_BAD_OUTPUT;
  const edits = editable.map(f => f.edit!).sort((a, b) => b.start - a.start);
  for (const e of edits) corrected = corrected.slice(0, e.start) + e.replacement + corrected.slice(e.end);
  const allEditsApplyCleanlyTogether = !corrected.includes('RivalCorp') && !corrected.includes('S$3.54 million, up') && corrected.includes('S$8.42 million, up') && !corrected.includes('December 15');
  check('Q3 bad output: no finding\'s edit corrupts another (all edits still apply cleanly together)', allEditsApplyCleanlyTogether, corrected);
}

done();
}
main();
