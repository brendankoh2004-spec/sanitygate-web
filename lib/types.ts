// =====================================================================
// SanityGate core types (pilot architecture)
//
// Responsibilities:
//   * deterministic layer  -> only hardcoded structural checks
//                             (word count, required/forbidden terms, list
//                             format, leftover placeholders)
//   * semantic layer       -> everything that needs understanding:
//                             instruction following, facts, numbers/dates
//                             in context, contradictions, causal claims
//   * verifier             -> independent verification + independent scan
// =====================================================================

// ---------------------------------------------------------------------
// Requirement ledger — the request split into individually judgeable items
// ---------------------------------------------------------------------
export type RequirementKind = 'instruction' | 'fact' | 'unclassified';
export type RequirementCategory = 'content' | 'prohibition' | 'format' | 'quantity' | 'order' | 'length' | 'other';

export interface RequirementItem {
  id: string;                          // R1, R2, ... (document order)
  kind: RequirementKind;               // unclassified = a request sentence extraction did not cover; the evaluator classifies it
  category: RequirementCategory | null;
  text: string;                        // concise restatement (facts name what each figure refers to)
  quote: string;                       // verbatim text from the REQUEST ('' only for the synthetic CTA item)
  quoteStart: number | null;           // validated span in the request
  quoteEnd: number | null;
}

// ---------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------
export type FindingCategory =
  | 'instruction_violation'   // output breaks/ignores an explicit instruction or prohibition
  | 'factual_contradiction'   // output states something different from reference information in the request
  | 'unsupported_addition'    // output asserts something (incl. causal claims) the request does not support
  | 'unsupported_causal_claim'
  | 'omission'                // output leaves out something the request required
  | 'structural';             // deterministic hardcoded check

export type Severity = 'critical' | 'warning';

/** Internal provenance — used for testing/debugging/analytics, never shown in the UI. */
export type FindingOrigin = 'deterministic' | 'evaluator' | 'verifier_scan' | 'evaluator+scan';
export type FindingVerification =
  | 'not_applicable'          // deterministic
  | 'confirmed'               // verifier independently confirmed with its own grounded evidence
  | 'uncertain'               // verifier could not decide
  | 'rejected_corroborated'   // verifier rejected, but an independent scan re-found it
  | 'unverified'              // verifier did not produce a usable verdict
  | 'scan_only';              // found only by the independent scan, never seen by the evaluator

/** A targeted change against the ORIGINAL output. Offsets never move. */
export interface TextEdit {
  start: number;
  end: number;              // start === end -> pure insertion
  original: string;         // exactly output.slice(start, end)
  replacement: string;      // '' -> removal
}

export interface Passage { start: number; end: number; text: string }

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  /** 'confirmed' = evaluator+verifier (or evaluator+independent scan) agree with grounded evidence. */
  strength: 'confirmed' | 'uncertain';
  origin: FindingOrigin;
  verification: FindingVerification;
  passage: Passage | null;          // programmatically located in the real output; text is sliced from the output, never model-supplied
  requirementQuote: string | null;  // programmatically located in the real request
  requirement: string | null;       // short human description of the requirement/fact concerned
  reason: string;                   // one concise sentence
  suggestion: string | null;        // human-readable suggested wording / advice
  edit: TextEdit | null;            // present only if the suggestion can be applied as a targeted edit
}

// ---------------------------------------------------------------------
// Additional checks — deterministic ones only, plus the CTA toggle which is
// routed to the semantic layer as a requirement.
// ---------------------------------------------------------------------
export interface AdditionalChecks {
  cta: boolean;
  bulletFormat: boolean;
  numberedFormat: boolean;
  requiredTerms: boolean;
  requiredTermsVal: string;
  forbiddenTerms: boolean;
  forbiddenTermsVal: string;
  maxWords: boolean;
  maxWordsVal: number;
  minWords: boolean;
  minWordsVal: number;
}

export const DEFAULT_ADDITIONAL: AdditionalChecks = {
  cta: false,
  bulletFormat: false, numberedFormat: false,
  requiredTerms: false, requiredTermsVal: '',
  forbiddenTerms: false, forbiddenTermsVal: '',
  maxWords: false, maxWordsVal: 500,
  minWords: false, minWordsVal: 50,
};

/** Never trust the shape of client-supplied settings. */
export function sanitizeAdditional(raw: unknown): AdditionalChecks {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof AdditionalChecks) => r[k] === true;
  const str = (k: keyof AdditionalChecks) => (typeof r[k] === 'string' ? (r[k] as string).slice(0, 1000) : '');
  const num = (k: keyof AdditionalChecks, d: number) => {
    const v = Number(r[k]);
    return Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? Math.floor(v) : d;
  };
  return {
    cta: bool('cta'), bulletFormat: bool('bulletFormat'), numberedFormat: bool('numberedFormat'),
    requiredTerms: bool('requiredTerms'), requiredTermsVal: str('requiredTermsVal'),
    forbiddenTerms: bool('forbiddenTerms'), forbiddenTermsVal: str('forbiddenTermsVal'),
    maxWords: bool('maxWords'), maxWordsVal: num('maxWordsVal', DEFAULT_ADDITIONAL.maxWordsVal),
    minWords: bool('minWords'), minWordsVal: num('minWordsVal', DEFAULT_ADDITIONAL.minWordsVal),
  };
}

// ---------------------------------------------------------------------
// Status model — four explicit states, never conflated.
//   clean            review fully completed, nothing found
//   findings         review fully completed, at least one confirmed finding
//   needs_review     review fully completed, everything found is uncertain
//   check_incomplete some part of the review could not be completed or
//                    verified. NEVER presented as clean, even with zero findings.
// ---------------------------------------------------------------------
export type CheckStatus = 'clean' | 'findings' | 'needs_review' | 'check_incomplete';
export type CheckStage = 'analysing' | 'reviewing' | 'verifying' | 'finalising';
/** The only failure vocabulary the user ever sees. */
export type IncompleteReason = 'busy' | 'timeout' | 'general';

// ---------------------------------------------------------------------
// Internal diagnostics (persisted, never sent to the browser)
// ---------------------------------------------------------------------
export interface StageDiagnostic {
  stage: string;
  ok: boolean;
  code: string | null;     // rate_limited | timeout | upstream_error | invalid_response | ...
  attempts: number;
  ms: number;
  partial: boolean;
  model?: string;
}
export interface PipelineDiagnostics {
  stages: StageDiagnostic[];
  notes: string[];
  counts: Record<string, number>;
}

export interface PipelineResult {
  findings: Finding[];
  passedChecks: string[];
  wordCount: number;
  durationMs: number;
  hasReference: boolean;
  requirements: RequirementItem[];
  checkStatus: CheckStatus;
  incompleteReason: IncompleteReason | null;
  /** Internal failure code (first failing stage). Stored in DB, NOT sent to the browser. */
  semanticError: string | null;
  diagnostics: PipelineDiagnostics;
}

/** What the browser receives / what history returns. */
export interface CheckRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  request: string;
  output: string;              // always the ORIGINAL output
  additional: AdditionalChecks;
  findings: Finding[];
  passedChecks: string[];
  wordCount: number;
  durationMs: number;
  hasReference: boolean;
  requirements: RequirementItem[];
  checkStatus: CheckStatus;
  incompleteReason: IncompleteReason | null;
}
