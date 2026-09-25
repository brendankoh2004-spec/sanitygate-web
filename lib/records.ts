/**
 * Record mapping: pipeline result <-> browser payload <-> database row.
 * All persistence shape knowledge lives here, so schema drift is caught by
 * one static test (test/persistence.test.ts) instead of by production 500s.
 * Rows written by earlier pipeline versions are normalised on read.
 */
import {
  CheckRecord, PipelineResult, AdditionalChecks, Finding, FindingCategory, RequirementItem,
  CheckStatus, IncompleteReason, DEFAULT_ADDITIONAL, sanitizeAdditional, PipelineDiagnostics,
} from './types';

export interface DbCheckRow {
  id: string;
  session_id: string;
  created_at: string;
  request: string;
  output: string;
  additional: AdditionalChecks;
  extracted_requirements: RequirementItem[];
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
  'id', 'session_id', 'created_at', 'request', 'output', 'additional', 'extracted_requirements', 'findings',
  'passed_checks', 'word_count', 'duration_ms', 'semantic_error', 'has_reference', 'check_status', 'diagnostics',
];

export function toClientRecord(base: { id: string; sessionId: string; createdAt: string; request: string; output: string; additional: AdditionalChecks }, r: PipelineResult): CheckRecord {
  return {
    ...base,
    findings: r.findings, passedChecks: r.passedChecks, wordCount: r.wordCount, durationMs: r.durationMs,
    hasReference: r.hasReference, requirements: r.requirements, checkStatus: r.checkStatus, incompleteReason: r.incompleteReason,
  };
}

/** `diagnostics` (stage outcomes, model ids, counters, notes) is persisted for engineers and never included in CheckRecord. */
export function toDbRow(rec: CheckRecord, r: PipelineResult): DbCheckRow {
  return {
    id: rec.id, session_id: rec.sessionId, created_at: rec.createdAt, request: rec.request, output: rec.output,
    additional: rec.additional, extracted_requirements: rec.requirements, findings: rec.findings,
    passed_checks: rec.passedChecks, word_count: rec.wordCount, duration_ms: rec.durationMs,
    semantic_error: r.semanticError, has_reference: rec.hasReference, check_status: rec.checkStatus, diagnostics: r.diagnostics,
  };
}

// ---------------------------------------------------------------------
// Legacy normalisation (rows written by the previous pipeline)
// ---------------------------------------------------------------------
const LEGACY_CATEGORY: Record<string, FindingCategory> = {
  missing_requirement: 'omission', requirement_violation: 'instruction_violation',
  contradiction: 'factual_contradiction', source_mismatch: 'factual_contradiction',
  numerical_mismatch: 'factual_contradiction', entity_mismatch: 'factual_contradiction',
  unsupported_claim: 'unsupported_addition', format_violation: 'structural',
};
const CATEGORIES: FindingCategory[] = ['instruction_violation', 'factual_contradiction', 'unsupported_addition', 'omission', 'structural'];

export function normalizeFinding(f: any, index: number): Finding | null {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.id === 'string' && f.id ? f.id : `f${index + 1}`;
  if (typeof f.category === 'string' && CATEGORIES.includes(f.category)) return { ...f, id } as Finding;   // current shape

  // legacy shape: { type, matchedText, start, end, evidence, suggestion, needsReview, source, ... }
  const category = LEGACY_CATEGORY[f.type] || 'instruction_violation';
  const hasSpan = typeof f.start === 'number' && typeof f.end === 'number' && typeof f.matchedText === 'string';
  return {
    id, category, severity: f.severity === 'critical' ? 'critical' : 'warning',
    strength: f.needsReview ? 'uncertain' : 'confirmed',
    origin: f.source === 'semantic' ? 'evaluator' : 'deterministic', verification: 'not_applicable',
    passage: hasSpan ? { start: f.start, end: f.end, text: f.matchedText } : null,
    requirementQuote: typeof f.evidence === 'string' ? f.evidence : null,
    requirement: typeof f.requirement === 'string' ? f.requirement : null,
    reason: typeof f.reason === 'string' ? f.reason : 'Potential issue detected.',
    suggestion: typeof f.suggestion === 'string' ? f.suggestion : null,
    edit: null,            // legacy suggestions were prose, not exact replacements: never auto-apply them
  };
}

function normalizeRequirements(x: any): RequirementItem[] {
  if (!Array.isArray(x)) return [];
  return x.filter(r => r && typeof r === 'object').map((r: any, i: number): RequirementItem => ({
    id: typeof r.id === 'string' ? r.id : `R${i + 1}`,
    kind: r.kind === 'fact' || r.type === 'fact' ? 'fact' : r.kind === 'unclassified' ? 'unclassified' : 'instruction',
    category: typeof r.category === 'string' ? r.category : null,
    text: typeof r.text === 'string' ? r.text : '', quote: typeof r.quote === 'string' ? r.quote : '',
    quoteStart: typeof r.quoteStart === 'number' ? r.quoteStart : null, quoteEnd: typeof r.quoteEnd === 'number' ? r.quoteEnd : null,
  }));
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
    hasReference: !!row.has_reference, requirements: normalizeRequirements(row.extracted_requirements),
    checkStatus: status, incompleteReason: status === 'check_incomplete' ? reasonFromCode(row.semantic_error) : null,
  };
}
