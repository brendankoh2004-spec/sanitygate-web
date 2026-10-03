// =====================================================================
// SanityGate core types (pilot architecture)
//
//   REQUEST + OUTPUT
//        |-- DIRECT MATCH   --\
//        |-- COVERAGE TRACE ---+--> flat ERROR POOL --> ADJUDICATOR (only if a reviewer raised an error) --> findings
//        |-- REVERSE CHECK  --/            ^
//        |-- DETERMINISTIC  ---------------+      (four parallel branches; PASS is discarded, FAIL joins the pool)
//
// Responsibilities:
//   * deterministic branch -> everything code can prove (word count, list
//                             format, required/forbidden terms, placeholders).
//                             A sibling of the reviewers, never a gate before them.
//   * semantic reviewers   -> three independent, parallel reads; a PASS is
//                             discarded, only actual errors enter the pool
//   * adjudicator          -> resolves the pooled reviewer candidates (confirm /
//                             reject / consolidate duplicates / categorise / fix).
//                             It never re-reviews the request and output, and
//                             never re-judges what code already proved.
// =====================================================================

// ---------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------
/** The ONE definition of what the semantic layer can report. Validators, prompts and persistence all derive from it. */
export const SEMANTIC_CATEGORIES = [
  'instruction_violation',    // output breaks/ignores an explicit instruction or prohibition, or does not respond to what the user communicated
  'factual_contradiction',    // output states something different from reference information in the request
  'unsupported_addition',     // output asserts a fact/figure/capability the request does not support
  'omission',                 // output leaves out something the request required or asked
  'unsupported_causal_claim', // output asserts a causal link the request does not establish (or denies)
] as const;
export type SemanticCategory = typeof SEMANTIC_CATEGORIES[number];

export type FindingCategory = SemanticCategory | 'structural';   // structural = deterministic hardcoded check
export const FINDING_CATEGORIES: readonly FindingCategory[] = [...SEMANTIC_CATEGORIES, 'structural'];

export type Severity = 'critical' | 'warning';

export type SemanticReviewer = 'direct' | 'coverage' | 'reverse';

/** Internal provenance — used for testing/debugging/analytics, never shown in the UI. 'legacy' = row written by an earlier pipeline. */
export type FindingOrigin = 'deterministic' | SemanticReviewer | 'legacy';
export type FindingVerification =
  | 'not_applicable'          // deterministic: proven by code, never adjudicated
  | 'adjudicated'             // the adjudicator resolved this candidate (see `strength` for the outcome)
  | 'unadjudicated'           // the adjudicator produced no usable decision for this candidate
  | 'legacy';                 // row written by an earlier pipeline

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
  /** 'confirmed' = proven by code, or confirmed by the adjudicator with evidence grounded in the real text. */
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
// routed to the Coverage Trace reviewer as an extra requirement.
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
//   check_incomplete some part of the review could not be completed. NEVER
//                    presented as clean, even with zero findings.
// ---------------------------------------------------------------------
export type CheckStatus = 'clean' | 'findings' | 'needs_review' | 'check_incomplete';
/** Product-facing progress stages. 'confirming' is only emitted when there are candidate errors to adjudicate. */
export type CheckStage = 'reviewing' | 'confirming' | 'finalising';
/** The only failure vocabulary the user ever sees. */
export type IncompleteReason = 'busy' | 'timeout' | 'general';

// ---------------------------------------------------------------------
// Internal diagnostics (persisted, never sent to the browser)
// ---------------------------------------------------------------------
export interface StageDiagnostic {
  stage: string;           // deterministic | direct | coverage | reverse | adjudicator
  ok: boolean;
  code: string | null;     // rate_limited | timeout | upstream_error | invalid_response | ...
  attempts: number;
  ms: number;              // wall-clock for this stage, all attempts included
  partial: boolean;
  model?: string;
  promptChars: number;     // size of the prompt sent (chars; ~4 chars per token)
  maxTokens: number;       // completion budget requested
  timeoutMs: number;       // effective timeout of the last attempt (0 = skipped before any call)
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
  checkStatus: CheckStatus;
  incompleteReason: IncompleteReason | null;
}
