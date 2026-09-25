/**
 * Manual, live-model sanity check for the Q3 long-case fixture (spec section 14).
 * Run with: npm run eval:q3-live
 * Requires OPENROUTER_API_KEY (loads .env.local itself, same as run_eval.ts).
 *
 * This is NOT part of the automated test suite (test/q3_long_case.test.ts covers
 * the architecture deterministically with a scripted model). This script exists
 * to sanity-check that a REAL configured model actually finds the 7 seeded errors
 * in evaluation/fixtures/q3.ts and stays clean on the correct version — i.e. that
 * the prompts in lib/prompts.ts work in practice, not just against a script.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPipeline } from '../lib/pipeline';
import { getProvider } from '../lib/llm';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { Q3_REQUEST, Q3_GOOD_OUTPUT, Q3_BAD_OUTPUT, Q3_ERRORS } from './fixtures/q3';

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

async function main() {
  loadEnvLocal();
  let providers;
  try {
    providers = { extraction: getProvider('extraction'), evaluator: getProvider('evaluator'), verifier: getProvider('verifier') };
  } catch (e: any) {
    console.error('Cannot run: LLM provider not configured. Set OPENROUTER_API_KEY (see .env.example).');
    console.error(e.message);
    process.exit(2);
  }
  console.log(`Evaluator:  ${providers!.evaluator!.name}:${providers!.evaluator!.model}`);
  console.log(`Verifier:   ${providers!.verifier!.name}:${providers!.verifier!.model}`);
  console.log(`Extraction: ${providers!.extraction!.name}:${providers!.extraction!.model}\n`);

  console.log('=== Running against the CORRECT (paraphrased/differently-notated) Q3 output ===');
  const good = await runPipeline(providers!, Q3_REQUEST, Q3_GOOD_OUTPUT, DEFAULT_ADDITIONAL);
  console.log(`status=${good.checkStatus} findings=${good.findings.length} durationMs=${good.durationMs}`);
  if (good.findings.length) {
    console.log('Findings on the CORRECT output (expected: none). This indicates false positives:');
    good.findings.forEach(f => console.log(`  [${f.category}/${f.strength}] ${f.reason} -- "${f.passage?.text ?? '(omission)'}"`));
  } else {
    console.log('Clean, as expected.');
  }

  console.log(`\n=== Running against the BROKEN Q3 output (${Q3_ERRORS.length} seeded errors) ===`);
  const bad = await runPipeline(providers!, Q3_REQUEST, Q3_BAD_OUTPUT, DEFAULT_ADDITIONAL);
  console.log(`status=${bad.checkStatus} findings=${bad.findings.length} durationMs=${bad.durationMs}`);
  bad.findings.forEach(f => console.log(`  [${f.category}/${f.strength}/${f.verification}] ${f.reason} -- "${f.passage?.text ?? '(omission)'}"${f.edit ? ` -> "${f.edit.replacement}"` : ''}`));

  console.log(`\nSeeded errors were: ${Q3_ERRORS.map(e => e.id).join(', ')}`);
  console.log(`Found ${bad.findings.length} findings vs ${Q3_ERRORS.length} seeded errors.`);
  console.log('\nThis is a manual spot-check, not a pass/fail gate — read the findings above yourself.');
  console.log('For an automated regression gate against many cases, use `npm run eval` (evaluation/run_eval.ts).');
}

main();
