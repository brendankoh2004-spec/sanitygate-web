/**
 * Spec requirement (section 21): "Do not trust an LLM-generated quote."
 * Every `generated_text` and `source_evidence` the evaluator claims must
 * be independently checked against the real text before it's shown to
 * the user as fact. This module is the only place that check happens,
 * so it's testable in isolation.
 */

export interface SpanMatch {
  found: boolean;
  exact: boolean;   // true = exact substring match; false = found via normalized fallback
  start: number | null;
  end: number | null;
}

/** Collapse whitespace/case for a forgiving-but-still-real fallback match —
 * catches cases where the model reproduced the text with different
 * spacing/line breaks but did NOT paraphrase or invent it. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findSpan(haystack: string, needle: string | null | undefined): SpanMatch {
  if (!needle || !needle.trim()) return { found: false, exact: false, start: null, end: null };

  const idx = haystack.indexOf(needle);
  if (idx >= 0) return { found: true, exact: true, start: idx, end: idx + needle.length };

  // Normalized fallback: only whitespace/case differences are forgiven.
  // This deliberately does NOT do fuzzy/semantic matching — a quote that
  // is merely "close" to the real text is exactly the kind of soft
  // hallucination this function exists to catch, not paper over.
  const normHay = normalize(haystack);
  const normNeedle = normalize(needle);
  if (normNeedle.length > 0 && normHay.includes(normNeedle)) {
    // Recover an approximate span in the original string for highlighting.
    // Walk the original string comparing normalized windows; if we can't
    // recover an exact span cheaply, report found-but-no-span (still
    // "verified", just not highlightable).
    const approxStart = haystack.toLowerCase().indexOf(needle.trim().toLowerCase());
    if (approxStart >= 0) {
      return { found: true, exact: false, start: approxStart, end: approxStart + needle.trim().length };
    }
    return { found: true, exact: false, start: null, end: null };
  }

  return { found: false, exact: false, start: null, end: null };
}

/**
 * Validates one candidate finding's claimed generated_text and
 * source_evidence against the real texts. Returns what should happen to
 * the finding's confidence/status as a result — this is deliberately
 * separate from "did the verifier LLM confirm it", since this check
 * requires no model call at all and catches a different failure mode
 * (fabricated quote) than the verifier catches (wrong conclusion from a
 * real quote).
 */
export interface EvidenceCheckResult {
  generatedTextSpan: SpanMatch;
  evidenceSpan: SpanMatch;
  /** If either claimed quote doesn't actually exist in the real text,
   * the finding must never be shown as high-confidence, regardless of
   * what the evaluator/verifier said. */
  forceNeedsReview: boolean;
  /** If the generated_text can't be found at all, we have nothing to
   * highlight and nothing trustworthy to show — suppress entirely. */
  suppress: boolean;
}

export function validateEvidence(output: string, request: string, generatedText: string | null, sourceEvidence: string | null): EvidenceCheckResult {
  const generatedTextSpan = findSpan(output, generatedText);
  const evidenceSpan = sourceEvidence ? findSpan(request, sourceEvidence) : { found: true, exact: true, start: null, end: null };

  // No claimed passage at all (e.g. a pure omission finding) is fine —
  // nothing to validate.
  const hasClaimedPassage = !!(generatedText && generatedText.trim());
  const suppress = hasClaimedPassage && !generatedTextSpan.found;
  const forceNeedsReview = (hasClaimedPassage && !generatedTextSpan.exact) ||
    (!!sourceEvidence && !!sourceEvidence.trim() && !evidenceSpan.found);

  return { generatedTextSpan, evidenceSpan, forceNeedsReview, suppress };
}
