import {
  Finding, PipelineResult, AdditionalChecks, CheckStatus, CheckStage, IncompleteReason, StageDiagnostic,
} from './types';
import { runReview, ReviewOutcome } from './review';
import { countWords } from './validators/deterministic';
import { editsConflict } from './edits';
import { LLMProvider } from './llm/provider';

/** One provider per role; each may point at a different model. A null role (no API key) fails that branch alone. */
export interface Providers {
  direct: LLMProvider | null;
  coverage: LLMProvider | null;
  reverse: LLMProvider | null;
  adjudicator: LLMProvider | null;
}
export interface PipelineHooks { onStage?: (s: CheckStage) => void }

/**
 * Soft time budget, kept comfortably under the platform hard limit
 * (app/api/check/route.ts: maxDuration = 60). Every model call is clamped to
 * what remains; a call that cannot fit is skipped and reported as an
 * incomplete review. Overridable so a Pro plan (maxDuration up to 300) can
 * simply raise it.
 */
export function pipelineBudgetMs(): number {
  const raw = process.env.PIPELINE_BUDGET_MS;
  if (raw === undefined || raw === '') return 50000;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 50000;
}

/**
 * Final assembly. Overlap between findings was already resolved by the adjudicator (it sees the deterministic
 * failures too), so the only cross-finding work left is mechanical: two edits that touch the same text cannot both
 * be auto-applied, so the lower-priority one is demoted to advice (its suggestion text is kept).
 */
function assemble(all: Finding[], counts: Record<string, number>): Finding[] {
  const rank = (f: Finding) => (f.origin === 'deterministic' ? 0 : f.strength === 'confirmed' ? 1 : 2);
  const keptEdits: NonNullable<Finding['edit']>[] = [];
  for (const f of [...all].sort((a, b) => rank(a) - rank(b))) {
    if (!f.edit) continue;
    if (keptEdits.some(k => editsConflict(k, f.edit!))) {
      f.edit = null;
      counts.edit_conflicts_demoted = (counts.edit_conflicts_demoted || 0) + 1;
    } else keptEdits.push(f.edit);
  }
  const sorted = [...all].sort((a, b) => (a.passage ? a.passage.start : Infinity) - (b.passage ? b.passage.start : Infinity));
  sorted.forEach((f, i) => { f.id = `f${i + 1}`; });
  return sorted;
}

function reasonFor(codes: string[]): IncompleteReason {
  if (codes.includes('rate_limited')) return 'busy';
  if (codes.includes('timeout')) return 'timeout';
  return 'general';
}

/** request + output -> runReview (four parallel branches -> pool -> adjudicator if needed) -> assemble -> status. */
export async function runPipeline(
  providers: Providers, request: string, output: string, adv: AdditionalChecks, hooks: PipelineHooks = {},
): Promise<PipelineResult> {
  const t0 = Date.now();
  const stages: StageDiagnostic[] = [];
  const hasRequest = !!request.trim();

  let review: ReviewOutcome;
  try {
    review = await runReview({ providers, request, output, adv, t0, budgetMs: pipelineBudgetMs(), diagnostics: stages, onStage: hooks.onStage });
  } catch (e) {
    // Defensive: an unexpected bug must degrade to "incomplete", never crash the request and never look clean.
    console.error(`[sanitygate:review] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    review = { findings: [], passedChecks: [], wordCount: countWords(output), failures: ['internal_error'], notes: [], counts: {} };
  }

  hooks.onStage?.('finalising');
  const counts = review.counts;
  const findings = assemble(review.findings, counts);

  const failures = review.failures;
  const failedCodes = [...failures, ...stages.filter(s => !s.ok).map(s => s.code || 'unknown')];
  const incomplete = failures.length > 0;
  const checkStatus: CheckStatus = incomplete
    ? 'check_incomplete'
    : findings.length === 0
      ? 'clean'
      : findings.some(f => f.strength === 'confirmed') ? 'findings' : 'needs_review';

  const durationMs = Date.now() - t0;
  console.error(`[sanitygate:pipeline] ${durationMs}ms status=${checkStatus} failures=${failures.join('|') || 'none'} findings=${findings.length}`);

  return {
    findings, passedChecks: review.passedChecks, wordCount: review.wordCount, durationMs,
    hasReference: hasRequest, checkStatus,
    incompleteReason: incomplete ? reasonFor(failedCodes) : null,
    semanticError: incomplete ? failures[0] : null,
    diagnostics: { stages, notes: review.notes, counts },
  };
}
