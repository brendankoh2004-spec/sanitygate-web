import { Finding, AdditionalChecks, DEFAULT_ADDITIONAL, RequirementType } from '../lib/types';
import { runPipeline, Providers } from '../lib/pipeline';

export interface GoldenCase {
  id: string;
  category: string;
  request: string;
  output: string;
  additional?: Partial<AdditionalChecks>;
  expected: {
    shouldFlag: boolean;
    ambiguous?: boolean;
    expectedTypes?: string[];
    matchSubstring?: string;
    evidenceSubstring?: string;
    suggestionContains?: string;
    /** Requirement types the extraction step should find at least one of,
     * for grading "did SanityGate correctly understand what was asked". */
    expectedExtractionTypes?: RequirementType[];
  };
}

export interface GradedCase {
  id: string;
  category: string;
  classification: 'TP' | 'FP' | 'FN' | 'TN';
  matched: Finding[];
  evidenceOk: boolean | null;
  suggestionOk: boolean | null;
  extractionOk: boolean | null;
  semanticError: string | null;
  durationMs: number;
}

function findingMatches(f: Finding, expected: GoldenCase['expected']): boolean {
  if (expected.matchSubstring) {
    const needle = expected.matchSubstring.toLowerCase();
    const haystack = `${f.matchedText || ''} ${f.reason || ''} ${f.evidence || ''}`.toLowerCase();
    return haystack.includes(needle);
  }
  if (expected.expectedTypes && expected.expectedTypes.length) {
    return expected.expectedTypes.includes(f.type);
  }
  return true;
}

export async function runGoldenCase(providers: Providers, c: GoldenCase): Promise<GradedCase> {
  const adv: AdditionalChecks = { ...DEFAULT_ADDITIONAL, ...(c.additional || {}) };
  const result = await runPipeline(providers, c.request, c.output, adv);
  const matched = result.findings.filter(f => findingMatches(f, c.expected));

  let classification: GradedCase['classification'];
  if (c.expected.shouldFlag) classification = matched.length > 0 ? 'TP' : 'FN';
  else classification = matched.length === 0 ? 'TN' : 'FP';

  let evidenceOk: boolean | null = null;
  if (c.expected.evidenceSubstring) {
    const withEvidence = matched.filter(f => f.evidence && f.source === 'semantic');
    evidenceOk = withEvidence.length > 0
      ? withEvidence.every(f => c.request.toLowerCase().includes((f.evidence || '').toLowerCase()))
      : null;
  }

  let suggestionOk: boolean | null = null;
  if (c.expected.suggestionContains) {
    const withSuggestion = matched.filter(f => f.suggestion);
    suggestionOk = withSuggestion.length > 0
      ? withSuggestion.some(f => (f.suggestion || '').toLowerCase().includes(c.expected.suggestionContains!.toLowerCase()))
      : false;
  }

  let extractionOk: boolean | null = null;
  if (c.expected.expectedExtractionTypes && c.expected.expectedExtractionTypes.length) {
    extractionOk = c.expected.expectedExtractionTypes.every(t => result.extractedRequirements.some(r => r.type === t));
  }

  return {
    id: c.id, category: c.category, classification, matched,
    evidenceOk, suggestionOk, extractionOk,
    semanticError: result.semanticError, durationMs: result.durationMs,
  };
}

export interface EvalSummary {
  totalCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
  evidenceAccuracy: number | null;
  suggestionGroundingAccuracy: number | null;
  requirementExtractionAccuracy: number | null;
  semanticFailures: number;
  byCategory: Record<string, { tp: number; fp: number; fn: number; tn: number }>;
}

export function summarize(graded: GradedCase[]): EvalSummary {
  const tp = graded.filter(g => g.classification === 'TP').length;
  const fp = graded.filter(g => g.classification === 'FP').length;
  const fn = graded.filter(g => g.classification === 'FN').length;
  const tn = graded.filter(g => g.classification === 'TN').length;

  const evidenceCases = graded.filter(g => g.evidenceOk !== null);
  const suggestionCases = graded.filter(g => g.suggestionOk !== null);
  const extractionCases = graded.filter(g => g.extractionOk !== null);

  const byCategory: EvalSummary['byCategory'] = {};
  for (const g of graded) {
    byCategory[g.category] = byCategory[g.category] || { tp: 0, fp: 0, fn: 0, tn: 0 };
    byCategory[g.category][g.classification.toLowerCase() as 'tp' | 'fp' | 'fn' | 'tn']++;
  }

  return {
    totalCases: graded.length,
    truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
    precision: (tp + fp) ? +(tp / (tp + fp)).toFixed(3) : null,
    recall: (tp + fn) ? +(tp / (tp + fn)).toFixed(3) : null,
    falsePositiveRate: (fp + tn) ? +(fp / (fp + tn)).toFixed(3) : null,
    evidenceAccuracy: evidenceCases.length ? +(evidenceCases.filter(g => g.evidenceOk).length / evidenceCases.length).toFixed(3) : null,
    suggestionGroundingAccuracy: suggestionCases.length ? +(suggestionCases.filter(g => g.suggestionOk).length / suggestionCases.length).toFixed(3) : null,
    requirementExtractionAccuracy: extractionCases.length ? +(extractionCases.filter(g => g.extractionOk).length / extractionCases.length).toFixed(3) : null,
    semanticFailures: graded.filter(g => g.semanticError).length,
    byCategory,
  };
}
