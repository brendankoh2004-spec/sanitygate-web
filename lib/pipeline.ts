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

// ---------------------------------------------------------------------
// Pipeline-wide time budget.
//
// app/api/check/route.ts sets `export const maxDuration = 60` (a Vercel
// serverless hard kill). Before this fix, each of the three LLM calls had
// its OWN independent AbortController timeout (extraction 8s, evaluator
// 24s, verifier 22s) with no coordination between them: worst case that
// is 54s of LLM time alone, before the rate-limit DB round trip, request
// parsing, evidence validation, dedupe, the Supabase insert, and response
// serialization are even counted. That leaves as little as ~6s of slack
// under the 60s cap in production — any added latency (a slow Supabase
// round trip, a cold start, ordinary network jitter) can push the whole
// function past 60s. When that happens Vercel kills the function outright
// (`Vercel Runtime Timeout Error: Task timed out after 60 seconds`,
// observed in production) which returns NO graceful JSON response at all
// — strictly worse for the user than a clean check_incomplete result.
//
// PIPELINE_BUDGET_MS is a soft budget, enforced in-process, that stays
// comfortably under the hard 60s cap. Each stage's actual timeout is
// clamped to whatever budget remains; if too little remains to
// reasonably attempt a call at all, the stage is skipped outright (and
// treated as a normal, already-handled failure of that stage) instead of
// firing off a call that has no realistic chance to finish before Vercel
// kills the whole request.
// Read at call time (not module load) — identical in production, since
// env vars don't change mid-process, but lets tests exercise the
// budget-exhaustion path by setting process.env.PIPELINE_BUDGET_MS
// before calling runPipeline.
function pipelineBudgetMs(): number {
  return Number(process.env.PIPELINE_BUDGET_MS || 50000);
}
// Below this much remaining budget, don't even attempt a stage — a call
// given less time than this has little realistic chance of a useful
// model response and just burns the remaining margin for nothing.
const MIN_VIABLE_TIMEOUT_MS = 4000;
// Minimum remaining budget required before attempting the one bounded
// evaluator retry (see runSemanticLayer) — retrying is only worth it if
// there's still meaningfully more than the minimum-viable window left.
const MIN_RETRY_BUDGET_MS = 6000;

/** Returns a timeout for this stage clamped to whatever pipeline budget
 * remains, or null if too little budget remains to attempt the call at
 * all (caller should skip/fail the stage rather than fire off a call
 * doomed to be cut short by the platform's own hard timeout). */
function clampedTimeout(t0: number, desiredMs: number): number | null {
  const remaining = pipelineBudgetMs() - (Date.now() - t0);
  if (remaining < MIN_VIABLE_TIMEOUT_MS) return null;
  return Math.min(desiredMs, remaining);
}

function remainingBudgetMs(t0: number): number {
  return pipelineBudgetMs() - (Date.now() - t0);
}

/** Step 1: turn the user's free-text request into a structured, auditable
 * requirement list. Never throws for "no requirements found" — only
 * throws (LLMError) on genuine provider failure, which the caller treats
 * as "extraction produced nothing usable" and proceeds anyway (see
 * runPipeline) rather than aborting the whole semantic review over it —
 * the evaluator still receives the raw request text either way and can
 * work from that directly. */
async function runExtraction(provider: LLMProvider, request: string, t0: number): Promise<ExtractedRequirement[]> {
  if (!request || !request.trim()) return [];
  const timeoutMs = clampedTimeout(t0, 8000);
  if (timeoutMs === null) {
    throw new LLMError('timeout', 'Insufficient pipeline time budget remaining to attempt extraction.');
  }
  const data = await provider.completeJSON<ExtractionResult>(buildExtractionPrompt(request), {
    temperature: 0.05, maxTokens: 1200, timeoutMs, stage: 'extraction',
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
  extracted: ExtractedRequirement[], adv: AdditionalChecks, t0: number,
): Promise<{ findings: Finding[]; evaluatorError: Error | null }> {
  if (!providers.evaluator) return { findings: [], evaluatorError: null };
  const hasRequest = !!(request && request.trim());
  if (!hasRequest && extracted.length === 0 && !adv.cta) return { findings: [], evaluatorError: null };

  const requirementsJson = JSON.stringify(extracted);
  const listItemCount = countListItems(output);
  const evaluatorPrompt = buildEvaluatorPrompt(request, output, requirementsJson, adv, listItemCount);

  async function callEvaluatorOnce(): Promise<CandidateIssue[]> {
    const timeoutMs = clampedTimeout(t0, 24000);
    if (timeoutMs === null) throw new LLMError('timeout', 'Insufficient pipeline time budget remaining to attempt the evaluator.');
    const data = await providers.evaluator!.completeJSON<{ issues: CandidateIssue[] }>(
      evaluatorPrompt, { temperature: 0.1, maxTokens: 2000, timeoutMs, stage: 'evaluator' },
    );
    return Array.isArray(data?.issues) ? data.issues : [];
  }

  let rawIssues: CandidateIssue[] = [];
  let evaluatorRan = false;
  let evaluatorError: Error | null = null;
  try {
    rawIssues = await callEvaluatorOnce();
    evaluatorRan = true;
  } catch (e) {
    const code = e instanceof LLMError ? e.code : 'upstream_error';
    // One bounded retry, and ONLY for invalid_response — the signature of
    // a single bad model draw from the randomized `openrouter/free`
    // router (see lib/llm/openrouter.ts): a reasoning-capable free model
    // burns its whole max_tokens budget on hidden "thinking" tokens
    // before emitting any visible content, hits finish_reason="length"
    // with an EMPTY message.content, and OpenRouterProvider correctly
    // throws invalid_response for it. Re-issuing the same request
    // typically routes to a different free model, which meaningfully
    // reduces the odds of hitting this twice in a row. A genuine timeout
    // or upstream rate limit is NOT retried here — retrying those just
    // spends more of an already-tight time budget for very low odds of
    // success (see PIPELINE_BUDGET_MS above).
    if (code === 'invalid_response' && remainingBudgetMs(t0) >= MIN_RETRY_BUDGET_MS) {
      console.error(`[sanitygate:evaluator] first attempt failed (invalid_response), retrying once`);
      try {
        rawIssues = await callEvaluatorOnce();
        evaluatorRan = true;
      } catch (e2) {
        evaluatorError = e2 instanceof Error ? e2 : new Error(String(e2));
      }
    } else {
      evaluatorError = e instanceof Error ? e : new Error(String(e));
    }
  }

  // The verifier's independent re-scan (Job 2 in lib/prompts.ts) is
  // valuable specifically because it does NOT depend on the evaluator's
  // candidates — buildVerifierPrompt already handles an empty candidate
  // list gracefully ("(none — the evaluator reported no issues)"). That
  // is exactly why it must still run here even when the evaluator failed
  // outright, not only when it returned zero issues: an evaluator that
  // never got a usable response is, from the verifier's point of view,
  // indistinguishable from an evaluator that looked and found nothing —
  // both leave the independent-scan job as the only remaining check.
  // Skipping the verifier on evaluator failure (the previous behavior)
  // meant a single bad model draw for ONE of the two model calls could
  // silence both, producing check_incomplete with zero chance of any
  // finding surfacing even when a second, independent model call could
  // have caught something.
  const verifierProvider = providers.verifier || providers.evaluator;
  let verified: VerifierResult = { verdicts: [], additional_findings: [] };
  let verifierRan = false;
  const verifierTimeoutMs = clampedTimeout(t0, 22000);
  if (verifierTimeoutMs === null) {
    console.error(`[sanitygate:verifier] skipped — insufficient pipeline time budget remaining`);
  } else {
    try {
      const v = await verifierProvider.completeJSON<VerifierResult>(
        buildVerifierPrompt(rawIssues, request, output, requirementsJson),
        { temperature: 0.1, maxTokens: 2000, timeoutMs: verifierTimeoutMs, stage: 'verifier' },
      );
      verified = {
        verdicts: Array.isArray(v?.verdicts) ? v.verdicts : [],
        additional_findings: Array.isArray(v?.additional_findings) ? v.additional_findings.slice(0, 5) : [],
      };
      verifierRan = true;
    } catch (e) {
      // Verifier call failed entirely. If the evaluator succeeded, its
      // own candidates are kept but marked explicitly unverified rather
      // than dropped — an intentional, documented fallback, distinct
      // from a genuine evaluator failure. Its "catch misses" role simply
      // did not run this time; nothing pretends otherwise.
      console.error(`[sanitygate:verifier] verifier call failed, independent re-check did not run: ${e instanceof LLMError ? e.code : (e as Error).message}`);
    }
  }

  const findings: Finding[] = [];

  // Only build findings from rawIssues/verdicts when the evaluator
  // actually produced candidates this round — verdicts is meaningless
  // when there was nothing for the verifier to verify (evaluatorRan is
  // false), and rawIssues stays [] in that case regardless.
  if (evaluatorRan) {
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
  }

  // The verifier's own independently-discovered findings are, by
  // definition, single-sourced (only one model pass has seen them — the
  // verifier didn't get a second opinion on its own discoveries the way
  // evaluator candidates do). They still go through the same
  // programmatic evidence check, but are always surfaced as "needs
  // review" rather than high-confidence, regardless of the stated
  // confidence — an honest reflection of "the checker's own judgment
  // flagged something", not a fully cross-verified finding. This applies
  // whether or not the evaluator itself succeeded this round.
  verified.additional_findings.forEach(issue => {
    const f = buildFinding(issue, request, output, Math.min(issue.confidence ?? 0.6, 0.7), true, false);
    if (f) findings.push(f);
  });

  return { findings, evaluatorError: evaluatorRan ? null : evaluatorError };
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
        extracted = await runExtraction(providers.extraction, request, t0);
      } catch (e) {
        console.error(`[sanitygate:extraction] extraction failed, proceeding with an empty requirement list: ${e instanceof LLMError ? e.code : (e as Error).message}`);
        extracted = [];
      }
      if (adv.cta) extracted = [...extracted, { type: 'required_content', text: 'The output must include a clear call to action.' }];

      try {
        const sem = await runSemanticLayer(providers, request, output, extracted, adv, t0);
        semanticFindings = sem.findings;
        if (sem.evaluatorError) {
          const code = sem.evaluatorError instanceof LLMError ? sem.evaluatorError.code : 'upstream_error';
          console.error(`[sanitygate:evaluator] semantic review failed: ${code}${sem.evaluatorError.message ? ' — ' + sem.evaluatorError.message : ''}`);
          semanticError = code;
        }
      } catch (e) {
        // Defensive fallback only — runSemanticLayer now handles the
        // evaluator's own failure internally (see above) so that the
        // verifier still gets a chance to run. This catch exists purely
        // so an unexpected throw elsewhere (e.g. a bug surfacing from
        // buildFinding/evidence validation) still degrades to
        // check_incomplete instead of crashing the whole request.
        const code = e instanceof LLMError ? e.code : 'upstream_error';
        console.error(`[sanitygate:evaluator] semantic review failed unexpectedly: ${code}${e instanceof Error ? ' — ' + e.message : ''}`);
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

  const durationMs = Date.now() - t0;
  console.error(`[sanitygate:pipeline] done in ${durationMs}ms status=${checkStatus} semanticError=${semanticError ?? 'none'} findings=${all.length} (deterministic=${det.findings.length}, semantic=${semanticFindings.length})`);

  return {
    findings: all,
    passedChecks: det.passed,
    wordCount: det.wordCount,
    durationMs,
    semanticError,
    hasReference: hasRequest,
    extractedRequirements: extracted,
    checkStatus,
  };
}
