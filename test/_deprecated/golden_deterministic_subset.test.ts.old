import { runDeterministic } from '../lib/validators/deterministic';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import golden from '../evaluation/golden_cases.json';

const deterministicRelevant = new Set([
  'num_equiv_million_001', 'num_equiv_decimal_001', 'num_equiv_percent_001',
  'num_approx_quantity_001', 'date_range_paraphrase_001', 'num_contextual_mismatch_001',
]);

let pass = 0, fail = 0;
for (const c of golden as any[]) {
  if (!deterministicRelevant.has(c.id)) continue;
  const adv = { ...DEFAULT_ADDITIONAL, ...(c.additional || {}) };
  const r = runDeterministic(c.request, c.output, adv);
  const numFindings = r.findings.filter(f => f.type === 'numerical_mismatch');
  const flagged = numFindings.length > 0;
  const ok = flagged === c.expected.shouldFlag;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.id}: expected shouldFlag=${c.expected.shouldFlag}, deterministic layer flagged=${flagged}${!ok ? ' -- ' + JSON.stringify(numFindings) : ''}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed (deterministic layer only, ${deterministicRelevant.size} cases checked)`);
if (fail > 0) process.exit(1);
