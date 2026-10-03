/**
 * Long, realistic multi-metric document. The scripted reviewers decide from the ACTUAL output text passed in their
 * prompt (nothing is hardcoded per run), and the scripted adjudicator only resolves the candidates it is given.
 * Proves: a clean paraphrased document costs zero adjudicator calls; a broken one yields exactly the 7 seeded errors.
 */
import { runPipeline } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { Q3_REQUEST, Q3_GOOD_OUTPUT, Q3_BAD_OUTPUT, Q3_ERRORS } from '../evaluation/fixtures/q3';
import { check, done, Scripted, allOf, PASS, issue, issues, decision, candidatesFromPrompt } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };

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
const outputOf = (prompt: string) => prompt.slice(prompt.lastIndexOf('--- OUTPUT ---') + '--- OUTPUT ---'.length).trim();
const report = (id: string) => { const e = Q3_ERRORS.find(x => x.id === id)!; return issue(e.category, { request_evidence: e.requestFragment, output_evidence: e.outputQuote, reason: `Detected: ${id}` }); };

function providersFor() {
  return allOf(new Scripted({
    // Coverage Trace finds instruction/fact/omission problems; Direct Match sees nothing off-topic; Reverse Check finds the unsupported causal claim.
    direct: PASS,
    coverage: (prompt: string) => {
      const out = outputOf(prompt);
      const found = ['wrong_metric_value', 'prohibited_competitor', 'negation_contradiction', 'wrong_date', 'omitted_loyalty', 'omitted_cta'].filter(id => isBroken(id, out));
      return found.length ? issues(...found.map(report)) : PASS;
    },
    reverse: (prompt: string) => (isBroken('unsupported_causal', outputOf(prompt.slice(prompt.indexOf('--- OUTPUT ---')))) ? issues(report('unsupported_causal')) : PASS),
    adjudicator: (prompt: string) => ({
      decisions: candidatesFromPrompt(prompt).map(c => {
        const err = Q3_ERRORS.find(e => c.reason === `Detected: ${e.id}`)!;
        return decision(c.id, { category: err.category, request_quote: err.requestFragment, output_quote: err.outputQuote, reason: `Confirmed: ${err.id}`, fix: err.fix ? { ...err.fix } : null });
      }),
    }),
  }));
}
const adjudicatorCalls = (p: ReturnType<typeof providersFor>) => (p.adjudicator as Scripted).callsFor('adjudicator').length;

async function main() {
{
  const p = providersFor();
  const r = await runPipeline(p, Q3_REQUEST, Q3_GOOD_OUTPUT, adv);
  check('Q3 good output: clean despite heavy paraphrase/notation differences', r.checkStatus === 'clean' && r.findings.length === 0, JSON.stringify(r.findings));
  check('Q3 good output: the adjudicator is never called', adjudicatorCalls(p) === 0);
  check('Q3 good output: no failures; exactly the four parallel branches recorded (3 reviewers + deterministic)', r.diagnostics.stages.length === 4 && r.diagnostics.stages.every(s => s.ok));
}
{
  const p = providersFor();
  const r = await runPipeline(p, Q3_REQUEST, Q3_BAD_OUTPUT, adv);
  check('Q3 bad output: exactly the 7 seeded errors, no extras, no drops', r.findings.length === Q3_ERRORS.length, `found ${r.findings.length}: ${JSON.stringify(r.findings.map(f => f.reason))}`);
  check('Q3 bad output: every finding is confirmed and adjudicated', r.findings.every(f => f.strength === 'confirmed' && f.verification === 'adjudicated'));
  check('Q3 bad output: one adjudicator call covers all seven', adjudicatorCalls(p) === 1 && r.checkStatus === 'findings');
  const by: Record<string, number> = {};
  r.findings.forEach(f => { by[f.category] = (by[f.category] || 0) + 1; });
  check('Q3 bad output: category mix (3 factual, 1 instruction, 1 causal, 2 omission)', by.factual_contradiction === 3 && by.instruction_violation === 1 && by.unsupported_causal_claim === 1 && by.omission === 2, JSON.stringify(by));
  const money = r.findings.filter(f => f.passage && f.passage.text.includes('3.54 million'));
  check('Q3 bad output: the same figure is right for online sales and wrong for total revenue; only the wrong use is flagged', money.length === 1 && money[0].edit?.replacement === 'S$8.42 million, up 6.3%', JSON.stringify(money));
  const editable = r.findings.filter(f => f.edit);
  check('Q3 bad output: 5 of 7 findings carry a validated edit (the 2 omissions have no scripted fix)', editable.length === 5);
  let corrected = Q3_BAD_OUTPUT;
  for (const e of editable.map(f => f.edit!).sort((a, b) => b.start - a.start)) corrected = corrected.slice(0, e.start) + e.replacement + corrected.slice(e.end);
  check('Q3 bad output: all edits apply together without corrupting each other', !corrected.includes('RivalCorp') && corrected.includes('S$8.42 million, up') && !corrected.includes('December 15') && !corrected.includes('which drove'), corrected);
}
done();
}
main();
