import { Finding, PipelineResult, AdditionalChecks, FindingType, ExtractedRequirement, ExtractionResult } from './types';
import { runDeterministic, dedupe, mkFinding, countListItems } from './validators/deterministic';
import { buildExtractionPrompt, buildEvaluatorPrompt, buildVerifierPrompt, CandidateIssue, VerifierVerdict } from './prompts';
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
    temperature: 0.05, maxTokens: 1400, timeoutMs: 10000, stage: 'extraction',
  });
  const reqs = Array.isArray(data?.requirements) ? data.requirements : [];
  const validTypes = new Set(['length', 'required_content', 'quantity', 'format', 'prohibition', 'order', 'fact']);
  return reqs.filter(r => r && validTypes.has(r.type)).map(r => ({
    type: r.type, text: String(r.text || '').slice(0, 300),
    quantityKind: r.quantityKind, quantityValue: typeof r.quantityValue === 'number' ? r.quantityValue : undefined,
  }));
}

/** Steps 2-4: evaluator -> programmatic evidence validation -> verifier
 * (+ suggestion self-check). Throws LLMError on failure of the evaluator
 * call specifically; the caller must surface this explicitly and never
 * treat it as "no issues found". A verifier-call failure is handled
 * locally (see below) rather than propagated, since we still have a
 * usable — just unverified — set of candidates to fall back on. */
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
    { temperature: 0.1, maxTokens: 2200, timeoutMs: 26000, stage: 'evaluator' },
  );
  const rawIssues = Array.isArray(evalData?.issues) ? evalData.issues : [];
  if (!rawIssues.length) return { findings: [] };

  const evidenceChecks = rawIssues.map(issue => validateEvidence(output, request, issue.generated_text, issue.source_evidence));

  const verifierProvider = providers.verifier || providers.evaluator;
  let verdicts: VerifierVerdict[] = [];
  try {
    const v = await verifierProvider.completeJSON<VerifierVerdict[]>(
      buildVerifierPrompt(rawIssues, request, output), { temperature: 0.1, maxTokens: 1400, timeoutMs: 13000, stage: 'verifier' },
    );
    verdicts = Array.isArray(v) ? v : [];
  } catch (e) {
    // Verifier call itself failed (evaluator succeeded). Keep candidates
    // but mark every one explicitly unverified rather than silently
    // dropping the whole semantic layer — this is an intentional,
    // documented fallback, distinct from a genuine evaluator failure.
    console.error(`[sanitygate:verifier] verifier call failed, falling back to "unverified" for ${rawIssues.length} candidate(s): ${e instanceof LLMError ? e.code : (e as Error).message}`);
    verdicts = rawIssues.map(() => ({ verdict: 'uncertain', confidence: 0.5, reason: 'Could not verify automatically.', suggestionOk: false }));
  }

  const findings: Finding[] = [];
  rawIssues.forEach((issue, i) => {
    const v = verdicts[i] || { verdict: 'rejected', confidence: 0, reason: 'No verification result.', suggestionOk: false };
    const evCheck = evidenceChecks[i];

    if (evCheck.suppress) return;
    if (v.verdict === 'rejected' && (typeof v.confidence !== 'number' || v.confidence < 0.4)) return;

    const modelConfidence = typeof v.confidence === 'number' ? v.confidence : (issue.confidence ?? 0.5);
    const finalConfidence = evCheck.forceNeedsReview ? Math.min(modelConfidence, 0.65) : modelConfidence;
    const needsReview = finalConfidence < 0.75 || v.verdict !== 'confirmed' || evCheck.forceNeedsReview;

    const suggestionHasContent = !!(issue.suggested_change && issue.suggested_change.trim());
    const suggestionVerified = suggestionHasContent ? !!v.suggestionOk : true;

    findings.push(mkFinding({
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
      needsReview,
      evidenceValidated: evCheck.generatedTextSpan.exact && evCheck.evidenceSpan.found,
    }));
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
      // instruction-following/source-grounding checking entirely. This
      // directly addresses a real failure mode: on a long, multi-
      // objective document, extraction is the stage most likely to run
      // out of its token budget, and previously any failure there
      // aborted everything downstream.
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
  return {
    findings: all,
    passedChecks: det.passed,
    wordCount: det.wordCount,
    durationMs: Date.now() - t0,
    semanticError,
    hasReference: hasRequest,
    extractedRequirements: extracted,
  };
}
