import {
  Finding, PipelineResult, AdditionalChecks, CheckStatus, CheckStage, IncompleteReason,
  RequirementItem, StageDiagnostic,
} from './types';
import { runDeterministic } from './validators/deterministic';
import { runSemanticReview } from './semantic';
import { editsConflict } from './edits';
import { spanOverlap, sameLocation } from './evidence';
import { LLMProvider } from './llm/provider';

export interface Providers {
  extraction: LLMProvider | null;
  evaluator: LLMProvider | null;
  verifier: LLMProvider | null;
}
export interface PipelineHooks { onStage?: (s: CheckStage) => void }

/**
 * Soft time budget, kept comfortably under the platform hard limit
 * (app/api/check/route.ts: maxDuration = 60). Every model call is clamped to
 * what remains; stages that cannot fit are skipped and reported as an
 * incomplete review. Overridable so a Pro plan (maxDuration up to 300) can
 * simply raise it.
 */
export function pipelineBudgetMs(): number {
  const raw = process.env.PIPELINE_BUDGET_MS;
  if (raw === undefined || raw === '') return 50000;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 50000;
}

const overlaps = (a: Finding, b: Finding) =>
  !!a.passage && !!b.passage && spanOverlap(a.passage, b.passage) > 0;

/** Where a finding "points at" in the ORIGINAL output, for de-duplication: the flagged passage, or (for a
 * passage-less omission) the location its own fix would insert at. */
function locationOf(f: Finding): { start: number; end: number } | null {
  if (f.passage) return { start: f.passage.start, end: f.passage.end };
  if (f.edit) return { start: f.edit.start, end: f.edit.end };
  return null;
}

/** True if two findings are the same underlying issue reported twice: same category, and either the same
 * located passage/insertion point, or — when neither has any location at all (an omission with no safe fix) —
 * the exact same request requirement. */
function sameIssue(a: Finding, b: Finding): boolean {
  if (a.category !== b.category) return false;
  const la = locationOf(a), lb = locationOf(b);
  if (la && lb) {
    const aIns = la.start === la.end, bIns = lb.start === lb.end;
    if (aIns && bIns) return la.start === lb.start;
    if (aIns || bIns) return false;   // an insertion and a replacement at the same neighbourhood are not the same edit
    return sameLocation(la, lb);
  }
  if (!la && !lb) return a.category === 'omission' && !!a.requirementQuote && a.requirementQuote === b.requirementQuote;
  return false;
}

/** Deterministic findings win over semantic findings on the same passage; conflicting edits keep the stronger finding's edit and demote the other to advice. */
function mergeFindings(det: Finding[], sem: Finding[], counts: Record<string, number>): Finding[] {
  const semKept = sem.filter(s => {
    const dup = det.some(d => overlaps(d, s));
    if (dup) counts.semantic_dropped_duplicate_of_deterministic = (counts.semantic_dropped_duplicate_of_deterministic || 0) + 1;
    return !dup;
  });
  // Two semantic findings about the same underlying issue reported twice (e.g. an instruction item AND an
  // unrequested-claim item pointing at the same causal sentence, or two related omission items both missing
  // the same content) collapse into one. Keep the stronger one.
  const sem2: Finding[] = [];
  for (const s of [...semKept].sort((a, b) => (a.strength === 'confirmed' ? 0 : 1) - (b.strength === 'confirmed' ? 0 : 1))) {
    const dup = sem2.find(k => sameIssue(k, s));
    if (dup) { counts.semantic_duplicates_merged = (counts.semantic_duplicates_merged || 0) + 1; continue; }
    sem2.push(s);
  }
  const all = [...det, ...sem2];
  const rank = (f: Finding) => (f.origin === 'deterministic' ? 0 : f.strength === 'confirmed' ? 1 : 2);
  const byPriority = [...all].sort((a, b) => rank(a) - rank(b));
  const keptEdits: NonNullable<Finding['edit']>[] = [];
  for (const f of byPriority) {
    if (!f.edit) continue;
    if (keptEdits.some(k => editsConflict(k, f.edit!))) {
      f.edit = null;                                       // stays as advice; suggestion text is retained
      counts.edit_conflicts_demoted = (counts.edit_conflicts_demoted || 0) + 1;
    } else keptEdits.push(f.edit);
  }
  const sorted = [...all].sort((a, b) => {
    const ap = a.passage ? a.passage.start : Infinity, bp = b.passage ? b.passage.start : Infinity;
    return ap - bp;
  });
  sorted.forEach((f, i) => { f.id = `f${i + 1}`; });
  return sorted;
}

function reasonFor(codes: string[]): IncompleteReason {
  if (codes.includes('rate_limited')) return 'busy';
  if (codes.includes('timeout')) return 'timeout';
  return 'general';
}

export async function runPipeline(
  providers: Providers, request: string, output: string, adv: AdditionalChecks, hooks: PipelineHooks = {},
): Promise<PipelineResult> {
  const t0 = Date.now();
  const det = runDeterministic(output, adv);
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  const stages: StageDiagnostic[] = [];

  const hasRequest = !!request.trim();
  const needsSemantic = hasRequest || adv.cta;

  let semFindings: Finding[] = [];
  let requirements: RequirementItem[] = [];
  let failures: string[] = [];

  if (needsSemantic) {
    if (!providers.extraction || !providers.evaluator || !providers.verifier) {
      failures = ['unavailable'];
    } else {
      try {
        const sem = await runSemanticReview({
          providers: { extraction: providers.extraction, evaluator: providers.evaluator, verifier: providers.verifier },
          request, output, adv, t0, budgetMs: pipelineBudgetMs(), diagnostics: stages,
          onStage: s => hooks.onStage?.(s),
        });
        semFindings = sem.findings; requirements = sem.requirements; failures = sem.failures;
        notes.push(...sem.notes); Object.entries(sem.counts).forEach(([k, v]) => { counts[k] = v; });
      } catch (e) {
        // Defensive: an unexpected bug must degrade to "incomplete", never crash the request and never look clean.
        console.error(`[sanitygate:semantic] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        failures = ['internal_error'];
      }
    }
  }

  hooks.onStage?.('finalising');
  const findings = mergeFindings(det.findings, semFindings, counts);

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
    findings, passedChecks: det.passed, wordCount: det.wordCount, durationMs,
    hasReference: hasRequest, requirements, checkStatus,
    incompleteReason: incomplete ? reasonFor(failedCodes) : null,
    semanticError: incomplete ? failures[0] : null,
    diagnostics: { stages, notes, counts },
  };
}
