import { runDeterministic } from '../lib/validators/deterministic';
import { DEFAULT_ADDITIONAL } from '../lib/types';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`OK   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

function findMoney(findings: any[]) { return findings.filter(f => f.type === 'numerical_mismatch'); }

// --- Test 1: $0.96 million vs $960,000 (no finding) ---
{
  const request = 'Operating profit was S$1.17 million in Q3 2026, compared with S$0.96 million in Q3 2025.';
  const output = 'Operating profit was S$1.17 million in Q3 2026, compared with S$960,000 in Q3 2025.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  check('Test1 $0.96 million == $960,000 -> no finding', findMoney(r.findings).length === 0, JSON.stringify(findMoney(r.findings)));
}

// --- Test 2: 42.0% vs 42% (no finding) ---
{
  const request = 'Gross margin improved to 42.0% in Q3 2026.';
  const output = 'Gross margin improved to 42% in Q3 2026.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  check('Test2 42.0% == 42% -> no finding', findMoney(r.findings).length === 0, JSON.stringify(findMoney(r.findings)));
}

// --- Test 3: $66.6 vs $66.60 (no finding) ---
{
  const request = 'The stock closed at $66.6 on the final trading day of the quarter.';
  const output = 'The stock closed at $66.60 on the final trading day of the quarter.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  check('Test3 $66.6 == $66.60 -> no finding', findMoney(r.findings).length === 0, JSON.stringify(findMoney(r.findings)));
}

// --- Test 4: real mismatch, $8.42M vs $9.42M (finding, focused evidence) ---
{
  const request = 'Revenue was $8.42 million in Q3 2026, driven by strong demand.';
  const output = 'Revenue was $9.42 million in Q3 2026, driven by strong demand.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  const found = findMoney(r.findings);
  check('Test4 $8.42M vs $9.42M -> flagged', found.length === 1, JSON.stringify(found));
  if (found.length === 1) {
    check('Test4 evidence is a focused sentence, not a dump', !!found[0].evidence && found[0].evidence.includes('$8.42 million') && found[0].evidence.length < 200, found[0].evidence);
    check('Test4 suggestion targets the specific figure', found[0].suggestion.includes('$9.42') && found[0].suggestion.includes('$8.42'), found[0].suggestion);
  }
}

// --- Contextual mismatch despite the number existing elsewhere in source ---
{
  const request = 'Total revenue reached $8.42 million in Q3 2026. Online sales contributed $3.54 million of the total.';
  const output = 'Total revenue reached $3.54 million in Q3 2026, driven by strong performance.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  const found = findMoney(r.findings);
  check('Contextual: $3.54M mislabeled as revenue -> flagged (not silently passed because 3.54M exists somewhere)', found.length === 1, JSON.stringify(found));
}

// --- Approximate quantities / date paraphrase must never be touched by the numeric validator at all ---
{
  const request = 'Loyalty membership grew to more than 4,820 members, enrolled throughout August 15 to September 30.';
  const output = 'Loyalty membership grew to more than 4,800 members, enrolled throughout August and September.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  check('Approximate quantity / date paraphrase -> no numeric finding manufactured', findMoney(r.findings).length === 0, JSON.stringify(findMoney(r.findings)));
}

// --- No confident contextual match at all -> must not flag ---
{
  const request = 'The company reported $2.87 million in marketing spend this quarter.';
  const output = 'Customer satisfaction scores rose to 91% this quarter, with $5.10 million allocated to new product development.';
  const r = runDeterministic(request, output, { ...DEFAULT_ADDITIONAL });
  check('No confident contextual match -> conservative, no finding manufactured', findMoney(r.findings).length === 0, JSON.stringify(findMoney(r.findings)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
