/**
 * Architecture guard. Fails if the retired extraction -> ledger -> evaluator -> verify/scan pipeline (or its
 * vocabulary) reappears in production code, or if the new pipeline's wiring is changed. Comments are stripped before
 * scanning, so an explanatory comment never trips it; executable code, strings, env names and types do.
 * Historical migrations (db/migrations) and data (golden_cases.json) legitimately mention retired names and are exempt.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SEMANTIC_CATEGORIES, FINDING_CATEGORIES } from '../lib/types';
import * as prompts from '../lib/prompts';
import { check, done } from './helpers';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1').replace(/^\s*--.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.next', '_deprecated'].includes(e.name)) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const PROD = [...walk('lib'), ...walk('app'), ...walk('evaluation')];
const CONFIG = ['.env.example', 'db/schema.sql'].filter(exists);

// ---- 1. retired identifiers must not exist in executable production code ----
const FORBIDDEN: [string, RegExp][] = [
  ['extraction prompt/stage', /buildExtractionPrompt|runExtraction|extractRequirements|EXTRACTION_MODEL|extraction_model|extractionModel/],
  ['requirement ledger', /RequirementItem|extractedRequirements|extracted_requirements|buildLedger|MAX_LEDGER|requirementExtractionAccuracy|requirement_extraction_accuracy/],
  ['evaluator stage', /buildEvaluatorPrompt|EVALUATOR_BATCH_SIZE|EVALUATOR_MODEL|evaluator_model|evaluatorModel|runEvaluator/],
  ['verify stage', /buildVerifyPrompt|VERIFIER_MODEL|verifier_model|verifierModel|runVerifier|verifyClaims/],
  ['scan stage / corroboration', /buildScanPrompt|runScan|verifier_scan|evaluator\+scan|corroborat/i],
  ['claim caps', /MAX_CLAIMS/],
  ['pre-adjudication reconciliation', /sameIssue|sameLocation|splitSentences|mergeFindings/],
  ['pre-rename orchestrator', /runSemanticReview|SemanticProviders|SemanticParams|SemanticOutcome/],
  ['retired LLM roles', /['"`](extraction|evaluator|verifier)['"`]/],
];
for (const f of PROD) {
  const code = stripComments(read(f));
  for (const [what, re] of FORBIDDEN) {
    const m = code.match(re);
    check(`no retired ${what} in ${f}`, !m, m ? `found "${m[0]}"` : undefined);
  }
}
for (const f of CONFIG) {
  const text = stripComments(read(f));
  const bad = f === 'db/schema.sql'
    ? /buildExtractionPrompt|EVALUATOR_BATCH_SIZE|verifier_scan|requirement_extraction_accuracy/   // schema keeps the retired NULLABLE legacy columns on purpose
    : /EVALUATOR_MODEL|VERIFIER_MODEL|EXTRACTION_MODEL|EVALUATOR_BATCH_SIZE/;
  check(`no retired configuration in ${f}`, !bad.test(text));
}
const envKeys = new Set(stripComments(read('.env.example')).split('\n').map(l => l.split('=')[0].trim()).filter(Boolean));
check('.env.example configures the four current roles', ['DIRECT_MODEL', 'COVERAGE_MODEL', 'REVERSE_MODEL', 'ADJUDICATOR_MODEL'].every(k => envKeys.has(k)));

// ---- 2. no retired module names ----
check('no lib file is named after a retired stage', !PROD.some(f => /(extract|ledger|evaluator|verifier|scan)/i.test(path.basename(f)) && f.startsWith('lib')));

// ---- 3. the runtime graph: four parallel branches -> flat pool -> at most one adjudicator ----
check('lib/semantic.ts (the pre-four-branch orchestrator) no longer exists', !exists('lib/semantic.ts'));
const review = stripComments(read('lib/review.ts'));
const pipeline = stripComments(read('lib/pipeline.ts'));
check('prompts.ts exports exactly the four current builders', Object.keys(prompts).filter(k => /^build/.test(k)).sort().join() === 'buildAdjudicatorPrompt,buildCoveragePrompt,buildDirectPrompt,buildReversePrompt');
check('the pipeline has one entry point into the review and runs no stage, and NO deterministic check, of its own', /runReview\(/.test(pipeline) && !/runStage\(/.test(pipeline) && !/runDeterministic/.test(pipeline));
check('review.ts: deterministic is a sibling branch pushed into the SAME task list as the reviewers, awaited by ONE Promise.all', (review.match(/Promise\.all\(/g) || []).length === 1 && /Promise\.all\(tasks\)/.test(review) && /jobs\.map\(j => reviewer\(/.test(review) && /tasks\.push\(deterministic\(\)\)/.test(review));
check('review.ts: runDeterministic is called only inside the deterministic branch', (review.match(/runDeterministic\(/g) || []).length === 1 && /const deterministic = async[\s\S]*?runDeterministic\(output, adv\)/.test(review));
check('review.ts: exactly two kinds of model call: the reviewer branch and one adjudicator', (review.match(/runStage</g) || []).length === 2);
check('the adjudicator call is guarded by an empty-candidate early return that sits BEFORE it', /if \(candidates\.length === 0\) return/.test(review) && review.indexOf('if (candidates.length === 0) return') < review.indexOf("name: 'adjudicator'"));
check('PASS from any branch is discarded before the pool (counted, never forwarded)', /bump\(counts, 'deterministic_pass'\)/.test(review) && /if \(r\.issues\.length === 0\) \{ if \(!r\.failure\) bump\(counts, 'reviewer_pass'\); continue; \}/.test(review));
check('no pre-adjudication matching/clustering of reviewer output', !/cluster|match(ed)?Issue|crossMatch|consisten/i.test(review));
check('adjudicator decisions are keyed by candidate id and unknown ids are ignored', /candidateIds\.includes\(id\)/.test(review));
check('reviewers share one absolute deadline', (review.match(/deadline: reviewDeadline/g) || []).length === 1 && /const reviewDeadline = t0 \+ budgetMs \* REVIEW_SHARE/.test(review));
check('a role without a provider fails its own branch only (no all-or-nothing gate in the pipeline)', /recordSkipped\(name, diagnostics\)/.test(review) && !/!direct \|\| !coverage/.test(pipeline));

// ---- 4. one authoritative category definition ----
const typesSrc = stripComments(read('lib/types.ts'));
check('SEMANTIC_CATEGORIES is exactly the five specified categories, in one place', JSON.stringify([...SEMANTIC_CATEGORIES]) === JSON.stringify(['instruction_violation', 'factual_contradiction', 'unsupported_addition', 'omission', 'unsupported_causal_claim']));
check('FindingCategory derives from it (semantic categories + structural)', FINDING_CATEGORIES.length === 6 && /export type FindingCategory = SemanticCategory \| 'structural'/.test(typesSrc));
const dups = PROD.filter(f => f !== 'lib/types.ts' && /\['instruction_violation',\s*'factual_contradiction'/.test(stripComments(read(f))));
check('no competing category list exists elsewhere in production code', dups.length === 0, dups.join(', '));
check('prompt category definitions are compiler-tied to SEMANTIC_CATEGORIES', /CATEGORY_DEFS: Record<SemanticCategory, string>/.test(stripComments(read('lib/prompts.ts'))));
check('origins are exactly deterministic | direct | coverage | reverse | legacy', /export type FindingOrigin = 'deterministic' \| SemanticReviewer \| 'legacy'/.test(typesSrc) && /SemanticReviewer = 'direct' \| 'coverage' \| 'reverse'/.test(typesSrc));
done();
