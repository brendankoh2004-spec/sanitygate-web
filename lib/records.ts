/**
 * Record mapping: pipeline result <-> browser payload <-> database row.
 * All persistence shape knowledge lives here, so schema drift is caught by
 * one static test (test/persistence.test.ts) instead of by production 500s.
 * Rows written by earlier pipeline versions are normalised on read.
 */
import {
  CheckRecord, PipelineResult, AdditionalChecks, Finding, FindingCategory, FINDING_CATEGORIES, FindingOrigin,
  CheckStatus, IncompleteReason, DEFAULT_ADDITIONAL, sanitizeAdditional, PipelineDiagnostics,
} from './types';

export interface DbCheckRow {
  id: string;
  session_id: string;
  created_at: string;
  request: string;
  output: string;
  additional: AdditionalChecks;
  findings: Finding[];
  passed_checks: string[];
  word_count: number;
  duration_ms: number;
  semantic_error: string | null;
  has_reference: boolean;
  check_status: CheckStatus;
  diagnostics: PipelineDiagnostics;
}

/** Every column of `checks` the application writes. Verified against db/schema.sql by test/persistence.test.ts. */
export const CHECKS_WRITE_COLUMNS: (keyof DbCheckRow)[] = [
  'id', 'session_id', 'created_at', 'request', 'output', 'additional', 'findings',
  'passed_checks', 'word_count', 'duration_ms', 'semantic_error', 'has_reference', 'check_status', 'diagnostics',
];

export function toClientRecord(base: { id: string; sessionId: string; createdAt: string; request: string; output: string; additional: AdditionalChecks }, r: PipelineResult): CheckRecord {
  return {
    ...base,
    findings: r.findings, passedChecks: r.passedChecks, wordCount: r.wordCount, durationMs: r.durationMs,
    hasReference: r.hasReference, checkStatus: r.checkStatus, incompleteReason: r.incompleteReason,
  };
}

/** `diagnostics` (stage outcomes, model ids, counters, notes) is persisted for engineers and never included in CheckRecord. */
export function toDbRow(rec: CheckRecord, r: PipelineResult): DbCheckRow {
  return {
    id: rec.id, session_id: rec.sessionId, created_at: rec.createdAt, request: rec.request, output: rec.output,
    additional: rec.additional, findings: rec.findings,
    passed_checks: rec.passedChecks, word_count: rec.wordCount, duration_ms: rec.durationMs,
    semantic_error: r.semanticError, has_reference: rec.hasReference, check_status: rec.checkStatus, diagnostics: r.diagnostics,
  };
}

// ---------------------------------------------------------------------
// Legacy normalisation (rows written by previous pipelines)
// ---------------------------------------------------------------------
const LEGACY_CATEGORY: Record<string, FindingCategory> = {
  missing_requirement: 'omission', requirement_violation: 'instruction_violation',
  contradiction: 'factual_contradiction', source_mismatch: 'factual_contradiction',
  numerical_mismatch: 'factual_contradiction', entity_mismatch: 'factual_contradiction',
  unsupported_claim: 'unsupported_addition', format_violation: 'structural',
};
const ORIGINS: readonly FindingOrigin[] = ['deterministic', 'direct', 'coverage', 'reverse', 'legacy'];

export function normalizeFinding(f: any, index: number): Finding | null {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.id === 'string' && f.id ? f.id : `f${index + 1}`;
  if (typeof f.category === 'string' && (FINDING_CATEGORIES as readonly string[]).includes(f.category)) {
    // Current category vocabulary. Origin/verification written by the evaluator/verifier pipeline are mapped to 'legacy'.
    const origin = ORIGINS.includes(f.origin) ? f.origin : 'legacy';
    const verification = ['not_applicable', 'adjudicated', 'unadjudicated', 'legacy'].includes(f.verification) ? f.verification : 'legacy';
    return { ...f, id, origin, verification } as Finding;
  }

  // oldest shape: { type, matchedText, start, end, evidence, suggestion, needsReview, source, ... }
  if (typeof f.type !== 'string') return null;   // not recognisable as a finding of any generation: drop it, never invent one
  const category = LEGACY_CATEGORY[f.type] || 'instruction_violation';
  const hasSpan = typeof f.start === 'number' && typeof f.end === 'number' && typeof f.matchedText === 'string';
  return {
    id, category, severity: f.severity === 'critical' ? 'critical' : 'warning',
    strength: f.needsReview ? 'uncertain' : 'confirmed',
    origin: f.source === 'semantic' ? 'legacy' : 'deterministic', verification: 'legacy',
    passage: hasSpan ? { start: f.start, end: f.end, text: f.matchedText } : null,
    requirementQuote: typeof f.evidence === 'string' ? f.evidence : null,
    requirement: typeof f.requirement === 'string' ? f.requirement : null,
    reason: typeof f.reason === 'string' ? f.reason : 'Potential issue detected.',
    suggestion: typeof f.suggestion === 'string' ? f.suggestion : null,
    edit: null,            // legacy suggestions were prose, not exact replacements: never auto-apply them
  };
}

export function reasonFromCode(code: string | null | undefined): IncompleteReason {
  if (code === 'rate_limited') return 'busy';
  if (code === 'timeout') return 'timeout';
  return 'general';
}

const STATUSES: CheckStatus[] = ['clean', 'findings', 'needs_review', 'check_incomplete'];

/** History read. Tolerates old rows and never leaks internal fields (semantic_error, diagnostics). */
export function fromDbRow(row: any): CheckRecord {
  // Legacy rows without a stored status: a set semantic_error means the review never completed.
  const status: CheckStatus = STATUSES.includes(row.check_status) ? row.check_status : (row.semantic_error ? 'check_incomplete' : 'clean');
  const findings = (Array.isArray(row.findings) ? row.findings : []).map(normalizeFinding).filter((f: Finding | null): f is Finding => !!f);
  return {
    id: String(row.id), sessionId: String(row.session_id), createdAt: String(row.created_at),
    request: typeof row.request === 'string' ? row.request : '', output: typeof row.output === 'string' ? row.output : '',
    additional: row.additional && typeof row.additional === 'object' ? sanitizeAdditional(row.additional) : { ...DEFAULT_ADDITIONAL },
    findings, passedChecks: Array.isArray(row.passed_checks) ? row.passed_checks : [],
    wordCount: Number(row.word_count) || 0, durationMs: Number(row.duration_ms) || 0,
    hasReference: !!row.has_reference,
    checkStatus: status, incompleteReason: status === 'check_incomplete' ? reasonFromCode(row.semantic_error) : null,
  };
}
