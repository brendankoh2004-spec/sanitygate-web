// ---------------------------------------------------------------------
// Requirement extraction (lib/prompts.ts buildExtractionPrompt / lib/pipeline.ts)
// ---------------------------------------------------------------------
// The user's first box ("what did you ask the AI to do?") is a single
// free-text blob that may contain instructions, reference facts, or
// both. Extraction turns it into a structured, auditable list BEFORE
// any compliance judgment is made — this is what lets the golden tests
// grade "did SanityGate even understand the request" separately from
// "did SanityGate judge compliance correctly".

export type RequirementType =
  | 'length'            // e.g. "<=500 words"
  | 'required_content'  // e.g. "must discuss implementation"
  | 'quantity'          // e.g. "exactly 5 recommendations"
  | 'format'            // e.g. "use bullet points"
  | 'prohibition'       // e.g. "do not mention pricing"
  | 'order'             // e.g. "explain the problem before the solution"
  | 'fact';             // reference information the output must stay consistent with, not an instruction

export type QuantityKind = 'exactly' | 'at_least' | 'no_more_than';

export interface ExtractedRequirement {
  type: RequirementType;
  text: string;               // requirement in the model's own words, kept short
  quantityKind?: QuantityKind; // only for type === 'quantity'
  quantityValue?: number;      // only for type === 'quantity'
}

export interface ExtractionResult {
  requirements: ExtractedRequirement[];
}

// ---------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------

export type FindingType =
  | 'missing_requirement'
  | 'requirement_violation'
  | 'contradiction'
  | 'unsupported_claim'
  | 'source_mismatch'
  | 'numerical_mismatch'
  | 'entity_mismatch'
  | 'format_violation';

export type Severity = 'critical' | 'warning';

export interface Finding {
  id: string;
  type: FindingType;
  severity: Severity;
  confidence: number; // 0..1
  source: 'deterministic' | 'semantic';
  start: number | null;
  end: number | null;
  matchedText: string | null;
  reason: string;
  evidence: string | null;       // short quote from the user's original box, if applicable
  requirement: string | null;    // the specific extracted requirement this relates to
  suggestion: string | null;
  suggestionVerified: boolean;   // false = a suggestion existed but failed verification and was dropped
  status: 'open' | 'dismissed' | 'applied';
  userVerdict: 'correct' | 'false_positive' | null;
  needsReview: boolean;
  evidenceValidated: boolean;    // true only if evidence text was programmatically confirmed to exist in the input
}

// ---------------------------------------------------------------------
// Additional checks — deliberately small and objective (spec section 4/16/31).
// No tone/quality/conciseness/"AI-ness" options. "Must include a CTA" is
// judgment-based (not reliably regex-able) so it's folded into the
// extracted requirements and evaluated semantically rather than by code;
// everything else here is evaluated by code alone.
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

export interface PipelineResult {
  findings: Finding[];
  passedChecks: string[];
  wordCount: number;
  durationMs: number;
  semanticError: string | null;
  hasReference: boolean; // true if the first box contained anything at all
  extractedRequirements: ExtractedRequirement[];
}

export interface CheckRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  request: string;   // "what did you ask the AI to do?" — the single input box
  output: string;
  additional: AdditionalChecks;
  findings: Finding[];
  passedChecks: string[];
  wordCount: number;
  durationMs: number;
  semanticError: string | null;
  hasReference: boolean;
  extractedRequirements: ExtractedRequirement[];
}
