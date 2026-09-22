import { Finding, PipelineResult, AdditionalChecks, FindingType, ExtractedRequirement, ExtractionResult } from './types';
import { runDeterministic, dedupe, mkFinding, countListItems } from './validators/deterministic';
import { buildExtractionPrompt, buildEvaluatorPrompt, buildVerifierPrompt, CandidateIssue, VerifierResult } from './prompts';
import { validateEvidence } from './evidence';
import { LLMProvider, LLMError } from './llm/provider';

const FINDING_TYPES: FindingType[] = [
  'missing_requirement', 'requirement_violation', 'contradiction', 'unsupported_claim',
  'source_mismatch', 'numerical_mismatch', 'entity_mismatch', 'format_violation',
];

export interface Providers {
  extraction: LLMProvider | null;
  evaluator: LLMProvider | null;
  verifier: LLMProvider | null;
}

/** Step 1: turn the user's free-text request into a structured, auditable
 * requirement list. Never throws for "no requirements found" — only
 * throws (LLMError) on genuine provider failure, which the caller treats
 * as "extraction produced nothing usable" and proceeds anyway (see
 * runPipeline) rather than aborting the whole semantic review over it —
 * the evaluator still receives the raw request text either way and can
 * work from that directly. */
async function runExtraction(provider: LLMProvider, request: string): Promise<ExtractedRequirement[]> {
  if (!request || !request.trim()) return [];
  const data = await provider.completeJSON<ExtractionResult>(buildExtractionPrompt(request), {
    temperature: 0.05, maxTokens: 1200, timeoutMs: 8000, stage: 'extraction',
  });
  const reqs = Array.isArray(data?.requirements) ? data.requirements : [];
  const validTypes = new Set(['length', 'required_content', 'quantity', 'format', 'prohibition', 'order', 'fact']);
  return reqs.filter(r => r && validTypes.has(r.type)).map(r => ({
    type: r.type, text: String(r.text || '').slice(0, 300),
    quantityKind: r.quantityKind, quantityValue: typeof r.quantityValue === 'number' ? r.quantityValue : undefined,
  }));
}

/** Turns one raw LLM-reported issue (from either the evaluator or the
 * verifier's own independent scan) into a Finding, running it through
 * the same programmatic evidence validation either way — evidence
 * fabrication is a risk regardless of which call produced the claim.
 * `sourceLabel` only affects internal bookkeeping (needsReview default),
 * never anything shown to a different model or trusted blindly. */
function buildFinding(issue: CandidateIssue, request: string, output: string, confidence: number, needsReview: boolean, suggestionVerified: boolean): Finding | null {
  const evCheck = validateEvidence(output, request, issue.generated_text, issue.source_evidence);
  if (evCheck.suppress) return null; // claimed passage doesn't exist in the output at all
  const finalConfidence = evCheck.forceNeedsReview ? Math.min(confidence, 0.65) : confidence;
  return mkFinding({
    type: FINDING_TYPES.includes(issue.type as FindingType) ? (issue.type as FindingType) : 'requirement_violation',
    severity: issue.severity === 'critical' ? 'critical' : 'warning',
    confidence: finalConfidence,
    source: 'semantic',
    start: evCheck.generatedTextSpan.start, end: evCheck.generatedTextSpan.end,
    matchedText: issue.generated_text || null,
    reason: issue.explanation || 'Potential issue detected.',
    evidence: evCheck.evidenceSpan.found ? (issue.source_evidence || null) : null,
    requirement: issue.requirement || null,
    suggestion: suggestionVerified ? (issue.suggested_change || null) : null,
    suggestionVerified,
    needsReview: needsReview || evCheck.forceNeedsReview,
    evidenceValidated: evCheck.generatedTextSpan.exact && evCheck.evidenceSpan.found,
  });
}

/** Steps 2-4: evaluator -> verifier, where the verifier has TWO jobs —
 * (a) skeptically confirm/reject each evaluator candidate, and (b)
 * independently re-inspect the original request/output itself for
 * anything the evaluator missed. (b) is what makes the verifier a real
 * second line of defence rather than a JSON-cleanup pass: it runs even
 * when the evaluator found zero candidates, which is exactly the
 * situation where a single-pass evaluator miss would otherwise become a
 * false "clean" result with nothing to catch it.
 *
 * Throws LLMError only on evaluator failure — the caller must surface
 * that explicitly and never treat it as "no issues found". A verifier
 * failure is handled locally: the evaluator's own candidates are still
 * usable (just unverified), even though the independent-miss-catching
 * pass didn't get to run that time. */
async function runSemanticLayer(
  providers: Providers, request: string, output: string,
  extracted: ExtractedRequirement[], adv: AdditionalChecks,
): Promise<{ findings: Finding[] }> {
  if (!providers.evaluator) return { findings: [] };
  const hasRequest = !!(request && request.trim());
  if (!hasRequest && extracted.length === 0 && !adv.cta) return { findings: [] };

  const requirementsJson = JSON.stringify(extracted);
  const listItemCount = countListItems(output);
  const evalData = await providers.evaluator.completeJSON<{ issues: CandidateIssue[] }>(
    buildEvaluatorPrompt(request, output, requirementsJson, adv, listItemCount),
    { temperature: 0.1, maxTokens: 2000, timeoutMs: 24000, stage: 'evaluator' },
  );
  const rawIssues = Array.isArray(evalData?.issues) ? evalData.issues : [];

  const verifierProvider = providers.verifier || providers.evaluator;
  let verified: VerifierResult = { verdicts: [], additional_findings: [] };
  let verifierRan = false;
  try {
    const v = await verifierProvider.completeJSON<VerifierResult>(
      buildVerifierPrompt(rawIssues, request, output, requirementsJson),
      { temperature: 0.1, maxTokens: 2000, timeoutMs: 22000, stage: 'verifier' },
    );
    verified = {
      verdicts: Array.isArray(v?.verdicts) ? v.verdicts : [],
      additional_findings: Array.isArray(v?.additional_findings) ? v.additional_findings.slice(0, 5) : [],
    };
    verifierRan = true;
  } catch (e) {
    // Verifier call failed entirely (evaluator succeeded). The evaluator's
    // own candidates are kept but marked explicitly unverified rather than
    // dropped — this is an intentional, documented fallback, distinct
    // from a genuine evaluator failure. Its "catch misses" role simply
    // did not run this time; nothing pretends otherwise.
    console.error(`[sanitygate:verifier] verifier call failed, evaluator candidates kept as unverified, independent re-check did not run: ${e instanceof LLMError ? e.code : (e as Error).message}`);
  }

  const findings: Finding[] = [];

  rawIssues.forEach((issue, i) => {
    const v = verified.verdicts[i] || (verifierRan
      ? { verdict: 'rejected', confidence: 0, reason: 'No verification result.', suggestionOk: false }
      : { verdict: 'uncertain', confidence: 0.5, reason: 'Could not verify automatically.', suggestionOk: false });
    if (v.verdict === 'rejected' && (typeof v.confidence !== 'number' || v.confidence < 0.4)) return;

    const modelConfidence = typeof v.confidence === 'number' ? v.confidence : (issue.confidence ?? 0.5);
    const needsReview = modelConfidence < 0.75 || v.verdict !== 'confirmed';
    const suggestionHasContent = !!(issue.suggested_change && issue.suggested_change.trim());
    const suggestionVerified = suggestionHasContent ? !!v.suggestionOk : true;

    const f = buildFinding(issue, request, output, modelConfidence, needsReview, suggestionVerified);
    if (f) findings.push(f);
  });

  // The verifier's own independently-discovered findings are, by
  // definition, single-sourced (only one model pass has seen them — the
  // verifier didn't get a second opinion on its own discoveries the way
  // evaluator candidates do). They still go through the same
  // programmatic evidence check, but are always surfaced as "needs
  // review" rather than high-confidence, regardless of the stated
  // confidence — an honest reflection of "the checker's own judgment
  // flagged something", not a fully cross-verified finding.
  verified.additional_findings.forEach(issue => {
    const f = buildFinding(issue, request, output, Math.min(issue.confidence ?? 0.6, 0.7), true, false);
    if (f) findings.push(f);
  });

  return { findings };
}

export async function runPipeline(
  providers: Providers, request: string, output: string, adv: AdditionalChecks,
): Promise<PipelineResult> {
  const t0 = Date.now();
  const det = runDeterministic(request, output, adv);

  let semanticFindings: Finding[] = [];
  let semanticError: string | null = null;
  let extracted: ExtractedRequirement[] = [];

  const hasRequest = !!(request && request.trim());
  const needsSemantic = hasRequest || adv.cta;

  if (needsSemantic) {
    if (!providers.extraction || !providers.evaluator) {
      semanticError = 'unavailable';
    } else {
      // Extraction failure is NOT fatal to the whole semantic review: the
      // evaluator prompt always includes the raw request text regardless
      // of whether extraction produced a clean structured list, so a
      // failed extraction degrades to "the evaluator works from the raw
      // text with an empty requirements list" rather than killing
      // instruction-following/source-grounding checking entirely.
      try {
        extracted = await runExtraction(providers.extraction, request);
      } catch (e) {
        console.error(`[sanitygate:extraction] extraction failed, proceeding with an empty requirement list: ${e instanceof LLMError ? e.code : (e as Error).message}`);
        extracted = [];
      }
      if (adv.cta) extracted = [...extracted, { type: 'required_content', text: 'The output must include a clear call to action.' }];

      try {
        const sem = await runSemanticLayer(providers, request, output, extracted, adv);
        semanticFindings = sem.findings;
      } catch (e) {
        const code = e instanceof LLMError ? e.code : 'upstream_error';
        console.error(`[sanitygate:evaluator] semantic review failed: ${code}${e instanceof Error ? ' — ' + e.message : ''}`);
        semanticError = code;
      }
    }
  }

  const all = dedupe([...det.findings, ...semanticFindings]);

  // Part 6 status model: CHECK_INCOMPLETE always wins — a failed check is
  // never presented as clean, no matter how many (or few) deterministic
  // findings happened to come back. Otherwise CLEAN only if genuinely
  // nothing was found at all; FINDINGS if anything high-confidence
  // exists; NEEDS_REVIEW if everything found is lower-confidence.
  const activeFindings = all;
  const checkStatus: PipelineResult['checkStatus'] = semanticError
    ? 'check_incomplete'
    : activeFindings.length === 0
      ? 'clean'
      : activeFindings.some(f => !f.needsReview)
        ? 'findings'
        : 'needs_review';

  return {
    findings: all,
    passedChecks: det.passed,
    wordCount: det.wordCount,
    durationMs: Date.now() - t0,
    semanticError,
    hasReference: hasRequest,
    extractedRequirements: extracted,
    checkStatus,
  };
}
