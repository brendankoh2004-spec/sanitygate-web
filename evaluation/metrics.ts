import { Finding, AdditionalChecks, DEFAULT_ADDITIONAL } from '../lib/types';
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
    /** Legacy vocabulary kept so golden_cases.json needs no rewrite; mapped below. */
    expectedTypes?: string[];
    matchSubstring?: string;
    evidenceSubstring?: string;
    suggestionContains?: string;
  };
}

export interface GradedCase {
  id: string;
  category: string;
  classification: 'TP' | 'FP' | 'FN' | 'TN';
  matched: Finding[];
  evidenceOk: boolean | null;
  suggestionOk: boolean | null;
  /** Non-null when the review was incomplete (internal label only). */
  semanticError: string | null;
  durationMs: number;
}

const TYPE_TO_CATEGORIES: Record<string, string[]> = {
  requirement_violation: ['instruction_violation', 'structural'],
  missing_requirement: ['omission', 'instruction_violation', 'structural'],
  format_violation: ['structural', 'instruction_violation'],
  unsupported_claim: ['unsupported_addition', 'unsupported_causal_claim', 'factual_contradiction', 'instruction_violation'],
  contradiction: ['factual_contradiction'],
  numerical_mismatch: ['factual_contradiction'],
  entity_mismatch: ['factual_contradiction'],
  source_mismatch: ['factual_contradiction'],
};

/** "role:model" for every role, for run reports. */
export function describeModels(p: Providers): Record<keyof Providers, string> {
  const d = (x: Providers[keyof Providers]) => (x ? `${x.name}:${x.model}` : 'unavailable');
  return { direct: d(p.direct), coverage: d(p.coverage), reverse: d(p.reverse), adjudicator: d(p.adjudicator) };
}

function findingMatches(f: Finding, expected: GoldenCase['expected']): boolean {
  if (expected.matchSubstring) {
    const needle = expected.matchSubstring.toLowerCase();
    const haystack = `${f.passage?.text || ''} ${f.reason || ''} ${f.requirementQuote || ''} ${f.suggestion || ''}`.toLowerCase();
    return haystack.includes(needle);
  }
  if (expected.expectedTypes && expected.expectedTypes.length) {
    const cats = expected.expectedTypes.flatMap(t => TYPE_TO_CATEGORIES[t] || [t]);
    return cats.includes(f.category);
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
    const withEvidence = matched.filter(f => f.requirementQuote);
    evidenceOk = withEvidence.length > 0
      ? withEvidence.every(f => c.request.toLowerCase().includes((f.requirementQuote || '').toLowerCase()))
      : null;
  }

  let suggestionOk: boolean | null = null;
  if (c.expected.suggestionContains) {
    const withSuggestion = matched.filter(f => f.suggestion);
    suggestionOk = withSuggestion.length > 0
      ? withSuggestion.some(f => (f.suggestion || '').toLowerCase().includes(c.expected.suggestionContains!.toLowerCase()))
      : false;
  }

  return {
    id: c.id, category: c.category, classification, matched, evidenceOk, suggestionOk,
    semanticError: result.checkStatus === 'check_incomplete' ? (result.semanticError || 'incomplete') : null,
    durationMs: result.durationMs,
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
  semanticFailures: number;
  byCategory: Record<string, { tp: number; fp: number; fn: number; tn: number }>;
}

export function summarize(graded: GradedCase[]): EvalSummary {
  const n = (k: GradedCase['classification']) => graded.filter(g => g.classification === k).length;
  const tp = n('TP'), fp = n('FP'), fn = n('FN'), tn = n('TN');
  const ratio = (num: number, den: number) => (den ? +(num / den).toFixed(3) : null);
  const ev = graded.filter(g => g.evidenceOk !== null);
  const sg = graded.filter(g => g.suggestionOk !== null);

  const byCategory: EvalSummary['byCategory'] = {};
  for (const g of graded) {
    byCategory[g.category] = byCategory[g.category] || { tp: 0, fp: 0, fn: 0, tn: 0 };
    byCategory[g.category][g.classification.toLowerCase() as 'tp' | 'fp' | 'fn' | 'tn']++;
  }
  return {
    totalCases: graded.length, truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), falsePositiveRate: ratio(fp, fp + tn),
    evidenceAccuracy: ratio(ev.filter(g => g.evidenceOk).length, ev.length),
    suggestionGroundingAccuracy: ratio(sg.filter(g => g.suggestionOk).length, sg.length),
    semanticFailures: graded.filter(g => g.semanticError).length,
    byCategory,
  };
}
