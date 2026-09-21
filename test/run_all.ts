/**
 * Lightweight test runner — no framework dependency. Runs every
 * *.test.ts in this directory as a child process (so one test file's
 * process.exit(1) doesn't stop the others from running) and reports an
 * aggregate pass/fail. These are pure unit/integration tests against
 * deterministic logic and mocked providers — they need no network
 * access and no live LLM, which is what makes them runnable in CI and
 * in this sandbox alike (unlike evaluation/run_eval.ts, which requires
 * a real OPENROUTER_API_KEY).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.test.ts')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  try {
    execFileSync('npx', ['tsx', path.join(DIR, f)], { stdio: 'inherit' });
  } catch (e) {
    failed++;
    console.log(`>>> ${f} FAILED`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed > 0 ? 1 : 0);
