/**
 * Persistence-layer tests (spec section 8): confirms every column the
 * application actually writes exists in db/schema.sql (so "the code is
 * correct but the database still expects the old architecture" can't
 * happen silently), and that the read path tolerates rows written by the
 * previous pipeline version.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CHECKS_WRITE_COLUMNS, toDbRow, toClientRecord, fromDbRow, normalizeFinding } from '../lib/records';
import { DEFAULT_ADDITIONAL, PipelineResult, SEMANTIC_CATEGORIES, FINDING_CATEGORIES } from '../lib/types';
import { check, done } from './helpers';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

// ---- static schema alignment ---------------------------------------------
{
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  const createBlockMatch = schema.match(/create table if not exists checks \(([\s\S]*?)\n\);/);
  check('db/schema.sql defines a `checks` table', !!createBlockMatch);
  const block = createBlockMatch ? createBlockMatch[1] : '';
  const columnNames = [...block.matchAll(/^\s*([a-z_]+)\s+[a-z]/gim)].map(m => m[1]).filter(n => !['primary', 'foreign', 'constraint', 'unique', 'check'].includes(n));

  const camelToSnake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  for (const col of CHECKS_WRITE_COLUMNS) {
    const snake = camelToSnake(col as string);
    check(`schema.sql \`checks\` table has every column the app writes: ${snake}`, columnNames.includes(snake), `columns found: ${columnNames.join(', ')}`);
  }

  // Every migration file must be idempotent-looking (uses IF NOT EXISTS / IF EXISTS / OR REPLACE / DO $$ guards),
  // since spec 8 requires "a fresh database and an upgraded existing database both work" and migrations get re-run.
  const migDir = path.join(ROOT, 'db', 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => f.endsWith('.sql'));
  check('all four migrations exist (0004 = parallel-review architecture)', migFiles.length >= 4 && migFiles.some(f => f.startsWith('0004_')), migFiles.join(', '));

  // The reviewer/adjudicator model columns must exist, and the retired evaluator/verifier/extraction columns must no
  // longer be mandatory, or every eval-run insert made by app/api/admin/eval would be rejected.
  const evalBlock = (schema.match(/create table if not exists eval_runs \(([\s\S]*?)\n\);/) || [])[1] || '';
  check('schema.sql eval_runs has reviewer_model and adjudicator_model', /reviewer_model text/.test(evalBlock) && /adjudicator_model text/.test(evalBlock));
  check('schema.sql eval_runs: retired evaluator/verifier/extraction columns are nullable (legacy rows only)', ['evaluator_model', 'verifier_model', 'extraction_model'].every(c => new RegExp(`${c} text(,|\\s*--|\\s*$)`, 'm').test(evalBlock) && !new RegExp(`${c} text not null`).test(evalBlock)));
  check('schema.sql eval_runs no longer has requirement_extraction_accuracy', !/requirement_extraction_accuracy/.test(evalBlock));
  const mig4 = fs.readFileSync(path.join(migDir, migFiles.find(f => f.startsWith('0004_'))!), 'utf8').toLowerCase();
  check('migration 0004 adds reviewer_model + adjudicator_model and relaxes the three retired NOT NULL columns', /add column if not exists reviewer_model/.test(mig4) && /add column if not exists adjudicator_model/.test(mig4) && ['evaluator_model', 'verifier_model', 'extraction_model'].every(c => new RegExp(`alter column ${c} drop not null`).test(mig4)));
  check('migration 0004 never drops checks data (extracted_requirements is kept for history)', !/drop column if exists extracted_requirements\n/.test(mig4.replace(/^--.*$/gm, '')) && !/drop table/.test(mig4));
  for (const f of migFiles) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8').toLowerCase();
    const looksIdempotent = /if not exists|if exists|or replace|do \$\$/.test(sql);
    check(`migration is idempotent-looking (safe to re-run): ${f}`, looksIdempotent);
  }
}

// ---- toDbRow / toClientRecord: internal fields never leak to the client, but ARE persisted ----
{
  const base = { id: 'c1', sessionId: 's1', createdAt: new Date('2026-09-25').toISOString(), request: 'Do X.', output: 'Did X.', additional: DEFAULT_ADDITIONAL };
  const result: PipelineResult = {
    findings: [], passedChecks: ['clean'], wordCount: 2, durationMs: 1234, hasReference: true,
    checkStatus: 'check_incomplete', incompleteReason: 'timeout', semanticError: 'timeout',
    diagnostics: { stages: [{ stage: 'direct', ok: false, code: 'timeout', attempts: 1, ms: 20000, partial: false, model: 'x', promptChars: 900, maxTokens: 1200, timeoutMs: 20000 }], notes: [], counts: { foo: 1 } },
  };
  const rec = toClientRecord(base, result);
  check('client record never carries semanticError or diagnostics', !('semanticError' in rec) && !('diagnostics' in rec));
  check('client record DOES carry the honest incomplete status the user needs to see', rec.checkStatus === 'check_incomplete' && rec.incompleteReason === 'timeout');
  const row = toDbRow(rec, result);
  check('db row DOES persist the internal diagnostics/error code for engineers to debug', row.diagnostics.stages[0].code === 'timeout' && row.semantic_error === 'timeout');
  check('db row is JSON-safe (round-trips through JSON, simulating a JSONB column)', JSON.parse(JSON.stringify(row)).check_status === 'check_incomplete');
}

// ---- fromDbRow: legacy rows from the previous pipeline are tolerated, not dropped or crashed on ----
{
  const legacyRow = {
    id: 'old1', session_id: 's1', created_at: '2026-01-01T00:00:00Z',
    request: 'Do X.', output: 'Did X wrong.',
    additional: { cta: true, weirdOldField: 'x' },       // extra junk field from an even older shape
    extracted_requirements: null,                         // never existed on the oldest rows
    findings: [
      { type: 'numerical_mismatch', severity: 'critical', confidence: 0.9, matchedText: '$3.54 million', start: 5, end: 19, evidence: '$8.42 million', suggestion: 'use $8.42 million', needsReview: false, source: 'semantic' },
      { type: 'contradiction', severity: 'warning', matchedText: 'approved', start: 0, end: 8, needsReview: true },
      { not: 'even close to a finding' },                  // must be dropped, not crash the whole read
    ],
    passed_checks: ['ok'], word_count: 4, duration_ms: 500,
    has_reference: true,
    // no check_status column on this row (predates it); semantic_error WAS set on old rows when the old pipeline failed
    semantic_error: 'llm_call_failed',
  };
  const rec = fromDbRow(legacyRow);
  check('legacy row without check_status, but with semantic_error set, is read as check_incomplete (never silently clean)', rec.checkStatus === 'check_incomplete' && rec.incompleteReason === 'general');
  check('legacy findings are remapped to current categories', rec.findings.length === 2 && rec.findings[0].category === 'factual_contradiction' && rec.findings[1].category === 'factual_contradiction');
  check('legacy finding with needsReview:true becomes strength "uncertain"; false becomes "confirmed"', rec.findings[0].strength === 'confirmed' && rec.findings[1].strength === 'uncertain');
  check('legacy finding without a suggestion never gets an auto-apply edit (legacy suggestions were prose, not exact spans)', rec.findings.every(f => f.edit === null));
  check('a genuinely unparseable entry in the findings array is dropped, not crashed on', true);   // implied by not throwing above
  check('the record no longer has any requirement ledger, whatever the old row carried', !('requirements' in rec));
  check('legacy findings get origin/verification "legacy", never a retired evaluator/verifier label', rec.findings.every(f => f.origin === 'legacy' || f.origin === 'deterministic') && rec.findings.every(f => f.verification === 'legacy'));
  check('additional is sanitized even for an old row carrying an unknown extra field', rec.additional.cta === true && !('weirdOldField' in rec.additional));
}

// ---- fromDbRow: a row with the current shape passes through unchanged ----
{
  const row = {
    id: 'c2', session_id: 's1', created_at: '2026-09-25T00:00:00Z', request: 'Do X.', output: 'Did X.',
    additional: DEFAULT_ADDITIONAL, extracted_requirements: [{ id: 'R1', text: 'a retired ledger row' }],   // deprecated column: ignored
    findings: [
      { id: 'f1', category: 'unsupported_causal_claim', severity: 'critical', strength: 'confirmed', origin: 'reverse', verification: 'adjudicated', passage: null, requirementQuote: null, requirement: null, reason: 'r', suggestion: null, edit: null },
      { id: 'f2', category: 'omission', severity: 'warning', strength: 'confirmed', origin: 'evaluator+scan', verification: 'verified_by_verifier', passage: null, requirementQuote: null, requirement: null, reason: 'r', suggestion: null, edit: null },
    ],
    passed_checks: [], word_count: 2, duration_ms: 10, has_reference: true, check_status: 'findings', semantic_error: null,
  };
  const rec = fromDbRow(row);
  check('current-shape row round-trips cleanly; the deprecated ledger column is ignored', rec.checkStatus === 'findings' && rec.incompleteReason === null && !('requirements' in rec));
  check('unsupported_causal_claim survives persistence + read-back with its reviewer origin', rec.findings[0].category === 'unsupported_causal_claim' && rec.findings[0].origin === 'reverse' && rec.findings[0].verification === 'adjudicated');
  check('a row written by the retired pipeline (origin evaluator+scan) is read as legacy, not dropped', rec.findings.length === 2 && rec.findings[1].origin === 'legacy' && rec.findings[1].verification === 'legacy');
}

// ---- normalizeFinding: direct unit coverage of the mapping table ----
{
  check('missing_requirement -> omission', normalizeFinding({ type: 'missing_requirement' }, 0)?.category === 'omission');
  check('unsupported_claim -> unsupported_addition', normalizeFinding({ type: 'unsupported_claim' }, 0)?.category === 'unsupported_addition');
  check('every SEMANTIC_CATEGORY (incl. unsupported_causal_claim) is accepted by the record validator; nothing else is invented', SEMANTIC_CATEGORIES.every(c => normalizeFinding({ category: c, origin: 'coverage', verification: 'adjudicated' }, 0)?.category === c) && FINDING_CATEGORIES.length === SEMANTIC_CATEGORIES.length + 1);
  check('unrecognised legacy type falls back to instruction_violation rather than being dropped', normalizeFinding({ type: 'something_new_and_unknown' }, 0)?.category === 'instruction_violation');
  check('null/garbage input is rejected, not thrown on', normalizeFinding(null, 0) === null && normalizeFinding('not an object', 0) === null);
}

done();
