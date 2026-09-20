/**
 * Run with: npm run eval
 * Requires OPENROUTER_API_KEY (and friends) to be set — either in the
 * real environment or in a .env.local file at the project root (this
 * script loads .env.local itself; no extra dependency required).
 *
 * Writes evaluation/results/run-<timestamp>.json and prints a report.
 * If evaluation/results/baseline.json exists, compares against it and
 * exits with code 1 if recall drops or the false-positive rate rises
 * by more than the thresholds below — wire this into CI so a change to
 * the evaluator/verifier/extraction prompts or a validator can't
 * silently make the checker worse ("test the tester", spec section 29/30).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoldenCase, runGoldenCase, summarize, GradedCase } from './metrics';
import { getProvider } from '../lib/llm';
import { Providers } from '../lib/pipeline';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    const v = vRaw.replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const REGRESSION_RECALL_DROP = 0.10;
const REGRESSION_FPR_INCREASE = 0.10;

async function main() {
  loadEnvLocal();

  let providers: Providers;
  try {
    providers = { extraction: getProvider('extraction'), evaluator: getProvider('evaluator'), verifier: getProvider('verifier') };
  } catch (e: any) {
    console.error('Cannot run evaluation: LLM provider not configured.');
    console.error(e.message);
    console.error('Set OPENROUTER_API_KEY in .env.local (see .env.example) and try again.');
    process.exit(2);
    throw new Error('unreachable'); // guarantees `providers` is definitely-assigned below without relying on @types/node typing process.exit as `never`
  }

  const casesPath = path.join(ROOT, 'evaluation', 'golden_cases.json');
  const cases: GoldenCase[] = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  console.log(`Loaded ${cases.length} golden cases.`);
  console.log(`Evaluator model:  ${providers.evaluator!.name}:${providers.evaluator!.model}`);
  console.log(`Verifier model:   ${providers.verifier!.name}:${providers.verifier!.model}`);
  console.log(`Extraction model: ${providers.extraction!.name}:${providers.extraction!.model}\n`);

  const graded: GradedCase[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.id} (${c.category})... `);
    try {
      const g = await runGoldenCase(providers, c);
      graded.push(g);
      console.log(`${g.classification}${g.semanticError ? ' [semantic error: ' + g.semanticError + ']' : ''}`);
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
      graded.push({ id: c.id, category: c.category, classification: 'FN', matched: [], evidenceOk: null, suggestionOk: null, extractionOk: null, semanticError: 'exception', durationMs: 0 });
    }
  }

  const summary = summarize(graded);
  console.log('\n=== SUMMARY ===');
  console.log(`Total cases:                    ${summary.totalCases}`);
  console.log(`True positives:                 ${summary.truePositives}`);
  console.log(`False positives:                ${summary.falsePositives}`);
  console.log(`False negatives:                ${summary.falseNegatives}`);
  console.log(`True negatives:                 ${summary.trueNegatives}`);
  console.log(`Precision:                      ${summary.precision}`);
  console.log(`Recall:                         ${summary.recall}`);
  console.log(`False positive rate:            ${summary.falsePositiveRate}`);
  console.log(`Evidence accuracy:              ${summary.evidenceAccuracy}`);
  console.log(`Suggestion grounding accuracy:  ${summary.suggestionGroundingAccuracy}`);
  console.log(`Requirement extraction accuracy:${summary.requirementExtractionAccuracy}`);
  console.log(`Semantic call failures:         ${summary.semanticFailures}`);
  console.log('\nBy category:');
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    console.log(`  ${cat.padEnd(32)} TP=${c.tp} FP=${c.fp} FN=${c.fn} TN=${c.tn}`);
  }

  const resultsDir = path.join(ROOT, 'evaluation', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const runFile = path.join(resultsDir, `run-${Date.now()}.json`);
  const payload = {
    createdAt: new Date().toISOString(),
    evaluatorModel: `${providers.evaluator!.name}:${providers.evaluator!.model}`,
    verifierModel: `${providers.verifier!.name}:${providers.verifier!.model}`,
    extractionModel: `${providers.extraction!.name}:${providers.extraction!.model}`,
    summary, graded,
  };
  fs.writeFileSync(runFile, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${runFile}`);

  const baselinePath = path.join(resultsDir, 'baseline.json');
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const bs = baseline.summary;
    console.log('\n=== REGRESSION CHECK vs baseline.json ===');
    console.log(`baseline recall=${bs.recall} fpr=${bs.falsePositiveRate}  ->  current recall=${summary.recall} fpr=${summary.falsePositiveRate}`);
    let regressed = false;
    if (bs.recall != null && summary.recall != null && summary.recall < bs.recall - REGRESSION_RECALL_DROP) {
      console.log(`REGRESSION: recall dropped by more than ${REGRESSION_RECALL_DROP * 100}pp`);
      regressed = true;
    }
    if (bs.falsePositiveRate != null && summary.falsePositiveRate != null && summary.falsePositiveRate > bs.falsePositiveRate + REGRESSION_FPR_INCREASE) {
      console.log(`REGRESSION: false-positive rate increased by more than ${REGRESSION_FPR_INCREASE * 100}pp`);
      regressed = true;
    }
    if (regressed) { console.log('\nEvaluation FAILED regression gate.'); process.exit(1); }
    console.log('No regression detected.');
  } else {
    console.log('\nNo baseline.json found yet. To set this run as the baseline for future regression checks:');
    console.log(`  cp "${runFile}" "${baselinePath}"`);
  }
}

main();
