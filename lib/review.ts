/**
 * Review: four independent branches -> one flat error pool -> (only if needed) one adjudicator.
 *
 *   REQUEST + OUTPUT
 *     |-- DIRECT MATCH   --\
 *     |-- COVERAGE TRACE ---+  one Promise.all; no branch reads another's result
 *     |-- REVERSE CHECK  ---+
 *     |-- DETERMINISTIC  --/   (code: word count, list format, required/forbidden terms, placeholders)
 *            PASS -> discarded      FAIL -> candidate in the pool
 *                         ERROR POOL (flat: D1.. deterministic, E1.. reviewer errors; no matching/clustering)
 *        no reviewer error?  -> stop, no model call (deterministic failures are already proven by code)
 *                      ADJUDICATOR (one call; resolves candidate ids only)
 *                      grounded findings + validated edits
 *
 * Rules this module enforces:
 *   - Branches are siblings. The deterministic branch is CPU-only and is started after the model calls are in
 *     flight, so it can never delay them and is never a gate in front of them.
 *   - A PASS from any branch is discarded: nothing about a successful check is forwarded.
 *   - The adjudicator only resolves pooled candidates (decisions are keyed by id; anything else is ignored). It sees
 *     deterministic failures as context for duplicates, but never re-judges them: code already proved them.
 *   - Every displayed quote is located in the REAL text; every edit is validated against the REAL output.
 *   - One branch failing never discards the others' candidates; the review is simply marked incomplete.
 */
import {
  Finding, SemanticCategory, SEMANTIC_CATEGORIES, SemanticReviewer, Severity, TextEdit,
  AdditionalChecks, StageDiagnostic, CheckStage,
} from './types';
import { LLMProvider } from './llm/provider';
import { findSpan, spanOverlap, Span } from './evidence';
import { runStage, StageOutcome, Validated } from './stage';
import {
  buildDirectPrompt, buildCoveragePrompt, buildReversePrompt, buildAdjudicatorPrompt,
  CTA_REQUIREMENT, CandidateForAdjudication, ProvenFailureForContext,
} from './prompts';
import { countWords, countListItems, runDeterministic, DeterministicResult } from './validators/deterministic';

// ---------------------------------------------------------------------
// small parsing helpers
// ---------------------------------------------------------------------
const str = (x: unknown, max = 600): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const asObj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null);
const oneOf = <T extends string>(x: unknown, allowed: readonly T[]): T | null => (typeof x === 'string' && (allowed as readonly string[]).includes(x) ? x as T : null);
const bump = (c: Record<string, number>, k: string, n = 1) => { c[k] = (c[k] || 0) + n; };

interface RawFix { original: string; replacement: string; insertAfter: string }
function parseFix(x: unknown): RawFix | null {
  const o = asObj(x);
  if (!o) return null;
  const f: RawFix = { original: str(o.original, 1000), replacement: str(o.replacement, 800), insertAfter: str(o.insert_after, 1000) };
  return f.original || f.insertAfter ? f : null;
}

// ---------------------------------------------------------------------
// The flat ERROR POOL
// ---------------------------------------------------------------------
interface PoolBase { id: string; requestEvidence: string; outputEvidence: string; reason: string }
export type SemanticEntry = PoolBase & { source: SemanticReviewer; type: SemanticCategory; inferredTask: string };
export type DeterministicEntry = PoolBase & { source: 'deterministic'; type: 'structural' };
export type PoolEntry = SemanticEntry | DeterministicEntry;
const isSemantic = (e: PoolEntry): e is SemanticEntry => e.source !== 'deterministic';

// ---------------------------------------------------------------------
// Reviewer parsing: {"status":"pass","issues":[]} | {"status":"issues","issues":[...]}
// ---------------------------------------------------------------------
interface RawIssue { type: SemanticCategory; requestEvidence: string; outputEvidence: string; reason: string; inferredTask: string }
const MAX_ISSUES_PER_REVIEWER = 10;

function validateReview(raw: unknown): Validated<RawIssue[]> | null {
  const o = asObj(raw);
  if (!o) return null;
  if (!Array.isArray(o.issues)) return o.status === 'pass' ? { value: [], complete: true } : null;
  const inferredTask = str(o.inferred_task, 300);   // Reverse Check only; '' for the other reviewers
  const issues: RawIssue[] = [];
  for (const it of o.issues.slice(0, MAX_ISSUES_PER_REVIEWER)) {
    const r = asObj(it);
    if (!r) continue;
    const issue: RawIssue = {
      // An unrecognised type is not a reason to lose a real candidate: the adjudicator assigns the final category.
      type: oneOf(r.type, SEMANTIC_CATEGORIES) || 'instruction_violation',
      requestEvidence: str(r.request_evidence, 1000), outputEvidence: str(r.output_evidence, 1000), reason: str(r.reason, 400), inferredTask,
    };
    if (!issue.reason && !issue.requestEvidence && !issue.outputEvidence) continue;
    issues.push(issue);
  }
  return { value: issues, complete: true };
}

// ---------------------------------------------------------------------
// Adjudicator parsing: decisions are keyed by CANDIDATE id only — it cannot introduce new findings
// ---------------------------------------------------------------------
type Verdict = 'confirmed' | 'rejected' | 'uncertain';
interface Decision {
  id: string; verdict: Verdict; duplicateOf: string; category: SemanticCategory | null; severity: Severity;
  requestQuote: string; outputQuote: string; reason: string; fix: RawFix | null;
}

function makeAdjudicatorValidator(candidateIds: string[], knownIds: Set<string>) {
  return (raw: unknown): Validated<Decision[]> | null => {
    const o = asObj(raw);
    if (!o || !Array.isArray(o.decisions)) return null;
    const seen = new Set<string>();
    const out: Decision[] = [];
    for (const d of o.decisions) {
      const r = asObj(d);
      const id = r ? str(r.id, 20) : '';
      const verdict = r && oneOf(r.verdict, ['confirmed', 'rejected', 'uncertain'] as const);
      if (!r || !verdict || !candidateIds.includes(id) || seen.has(id)) continue;   // unknown ids (e.g. a "new" finding) are ignored
      seen.add(id);
      const dup = str(r.duplicate_of, 20);
      out.push({
        id, verdict, duplicateOf: dup && dup !== id && knownIds.has(dup) ? dup : '',
        category: oneOf(r.category, SEMANTIC_CATEGORIES), severity: r.severity === 'critical' ? 'critical' : 'warning',
        requestQuote: str(r.request_quote, 1000), outputQuote: str(r.output_quote, 1000), reason: str(r.reason, 400), fix: parseFix(r.fix),
      });
    }
    return { value: out, complete: candidateIds.every(i => seen.has(i)) };
  };
}

// ---------------------------------------------------------------------
// Evidence grounding: every displayed quote is sliced from the REAL text
// ---------------------------------------------------------------------
interface Located { span: Span | null; ambiguous: boolean; claimed: boolean }

/** First quote that exists in the real text wins. `claimed` = some non-empty quote was offered. */
function locateFirst(text: string, quotes: string[]): Located {
  const offered = quotes.filter(q => q && q.trim());
  for (const q of offered) {
    const m = findSpan(text, q);
    if (m.found) return { span: { start: m.start!, end: m.end! }, ambiguous: m.occurrences > 1, claimed: true };
  }
  return { span: null, ambiguous: false, claimed: offered.length > 0 };
}

/** Real REQUEST text for the evidence, or (for the user's "must include a CTA" setting) the fixed setting sentence. */
function groundRequest(request: string, adv: AdditionalChecks, quotes: string[]): { text: string | null; claimed: boolean } {
  const loc = locateFirst(request, quotes);
  if (loc.span) return { text: request.slice(loc.span.start, loc.span.end), claimed: true };
  if (adv.cta && quotes.some(q => q.trim().toLowerCase() === CTA_REQUIREMENT.toLowerCase())) return { text: CTA_REQUIREMENT, claimed: true };
  return { text: null, claimed: loc.claimed };
}

/** What the adjudicator is shown for a candidate: real text only, plus a flag for any evidence that could not be located. */
function toPromptCandidate(c: SemanticEntry, request: string, output: string, adv: AdditionalChecks): CandidateForAdjudication {
  const o = locateFirst(output, [c.outputEvidence]);
  const r = groundRequest(request, adv, [c.requestEvidence]);
  const unlocated: ('request' | 'output')[] = [];
  if (r.claimed && r.text === null) unlocated.push('request');
  if (o.claimed && !o.span) unlocated.push('output');
  return {
    id: c.id, source: c.source, type: c.type, reason: c.reason, inferredTask: c.inferredTask, unlocated,
    requestEvidence: r.text ?? '', outputEvidence: o.span ? output.slice(o.span.start, o.span.end) : '',
  };
}

// ---------------------------------------------------------------------
// Safe edits: model-proposed text never bypasses deterministic validation
// ---------------------------------------------------------------------
function buildEdit(fix: RawFix | null, passage: Span | null, output: string): TextEdit | null {
  if (!fix) return null;
  if (fix.insertAfter) {
    const m = findSpan(output, fix.insertAfter);
    if (!m.found || m.occurrences !== 1 || !fix.replacement) return null;
    const before = output.slice(0, m.end!);
    const glue = /\s$/.test(before) || /^[\s.,;:!?)]/.test(fix.replacement) ? '' : ' ';
    return { start: m.end!, end: m.end!, original: '', replacement: glue + fix.replacement };
  }
  const m = findSpan(output, fix.original);
  if (!m.found || m.occurrences !== 1) return null;
  if (passage && spanOverlap(passage, { start: m.start!, end: m.end! }) === 0) return null;   // fix must touch the flagged passage
  const original = output.slice(m.start!, m.end!);
  if (original === fix.replacement) return null;
  return { start: m.start!, end: m.end!, original, replacement: fix.replacement };
}

interface Ctx { request: string; output: string; adv: AdditionalChecks }

/** Turns one pooled candidate (+ the adjudicator's decision for it, if any) into a Finding with grounded evidence. */
function materialize(c: SemanticEntry, d: Decision | null, ctx: Ctx, strengthIn: 'confirmed' | 'uncertain'): Finding {
  const { request, output, adv } = ctx;
  const category: SemanticCategory = d?.category || c.type;
  const out = locateFirst(output, [d?.outputQuote ?? '', c.outputEvidence]);
  const req = groundRequest(request, adv, [d?.requestQuote ?? '', c.requestEvidence]);

  let strength = strengthIn;
  if (out.claimed && !out.span) strength = 'uncertain';                 // claimed passage doesn't exist in the output
  if (req.claimed && req.text === null) strength = 'uncertain';         // claimed request evidence doesn't exist
  if (category !== 'omission' && !out.span) strength = 'uncertain';     // nothing located to point at
  if (category === 'omission' && req.text === null) strength = 'uncertain';   // omission with no request evidence

  const passage = out.span ? { start: out.span.start, end: out.span.end, text: output.slice(out.span.start, out.span.end) } : null;
  const fix = d?.fix ?? null;
  const edit = out.ambiguous && !fix?.insertAfter ? null : buildEdit(fix, out.span, output);
  return {
    id: 'tmp', category, severity: d?.severity ?? 'warning', strength, origin: c.source,
    verification: d ? 'adjudicated' : 'unadjudicated',
    passage, requirementQuote: req.text, requirement: req.text === CTA_REQUIREMENT ? 'Must include a call to action' : null,
    reason: d?.reason || c.reason || 'The output does not match the request here.',
    suggestion: edit ? edit.replacement : (fix?.replacement || null), edit,
  };
}

// ---------------------------------------------------------------------
// Orchestration: four independent branches -> one flat pool -> (only if needed) one adjudicator
// ---------------------------------------------------------------------
/** One provider per role; any may be null (no key configured): that branch then fails alone as 'unavailable'. */
export interface ReviewProviders { direct: LLMProvider | null; coverage: LLMProvider | null; reverse: LLMProvider | null; adjudicator: LLMProvider | null }
export interface ReviewParams {
  providers: ReviewProviders;
  request: string; output: string; adv: AdditionalChecks;
  t0: number; budgetMs: number;
  diagnostics: StageDiagnostic[];
  onStage?: (s: CheckStage) => void;
}
export interface ReviewOutcome {
  /** Deterministic findings (proven by code) + adjudicated semantic findings. Ids and ordering are assigned by the pipeline. */
  findings: Finding[];
  passedChecks: string[];
  wordCount: number;
  /** Empty = every branch completed. Codes are internal. */
  failures: string[];
  notes: string[];
  counts: Record<string, number>;
}

/** Branches get the front of the budget as one shared absolute deadline; the adjudicator (one call) always keeps the rest. */
const REVIEW_SHARE = 0.6;
const REVIEWER_MS = 20000;
const ADJUDICATOR_MS = 20000;

interface BranchResult { source: PoolEntry['source']; failure: string | null; issues: RawIssue[]; det: DeterministicResult | null }

function recordSkipped(stage: string, diagnostics: StageDiagnostic[]) {
  diagnostics.push({ stage, ok: false, code: 'unavailable', attempts: 0, ms: 0, partial: false, promptChars: 0, maxTokens: 0, timeoutMs: 0 });
}

export async function runReview(p: ReviewParams): Promise<ReviewOutcome> {
  const { providers, request, output, adv, t0, budgetMs, diagnostics } = p;
  const failures: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = {};
  const ctx: Ctx = { request, output, adv };
  const hasRequest = !!request.trim();
  const needsSemantic = hasRequest || adv.cta;
  const measured = { wordCount: countWords(output), listItems: countListItems(output) };
  // A progress notification must never be able to break a check.
  const notify = (s: CheckStage) => { try { p.onStage?.(s); } catch (e) { console.error(`[sanitygate:review] onStage hook threw: ${e instanceof Error ? e.message : String(e)}`); } };

  notify('reviewing');
  const reviewDeadline = t0 + budgetMs * REVIEW_SHARE;

  // ---- 1. FOUR independent branches, one Promise.all ---------------------
  const reviewer = async (name: SemanticReviewer, prompt: string): Promise<BranchResult> => {
    const provider = providers[name];
    if (!provider) { recordSkipped(name, diagnostics); return { source: name, failure: 'unavailable', issues: [], det: null }; }
    const o = await runStage<RawIssue[]>({
      name, provider, prompt, desiredMs: REVIEWER_MS, deadline: reviewDeadline, maxTokens: 1200, diagnostics, validate: validateReview,
    });
    if (!o.ok) return { source: name, failure: o.code, issues: [], det: null };   // this branch failed; the others are unaffected
    return { source: name, failure: o.partial ? `incomplete_${name}` : null, issues: o.value, det: null };
  };
  const deterministic = async (): Promise<BranchResult> => {
    const started = Date.now();
    let det: DeterministicResult | null = null, failure: string | null = null;
    try { det = runDeterministic(output, adv); }
    catch (e) { failure = 'deterministic_error'; console.error(`[sanitygate:deterministic] failed: ${e instanceof Error ? e.message : String(e)}`); }
    diagnostics.push({ stage: 'deterministic', ok: !failure, code: failure, attempts: 1, ms: Date.now() - started, partial: false, promptChars: 0, maxTokens: 0, timeoutMs: 0 });
    return { source: 'deterministic', failure, issues: [], det };
  };

  // With no REQUEST text (CTA-only run) there is nothing for Direct Match / Reverse Check to compare against.
  const jobs: { name: SemanticReviewer; prompt: string }[] = !needsSemantic ? [] : hasRequest
    ? [
        { name: 'direct', prompt: buildDirectPrompt(request, output) },
        { name: 'coverage', prompt: buildCoveragePrompt(request, output, measured, adv.cta) },
        { name: 'reverse', prompt: buildReversePrompt(request, output) },
      ]
    : [{ name: 'coverage', prompt: buildCoveragePrompt(request, output, measured, adv.cta) }];
  if (needsSemantic && !hasRequest) notes.push('no_request_coverage_only');

  // The model calls are started first (each runs synchronously up to its network call); the CPU-only deterministic
  // branch is started last, so it can never delay them.
  const tasks: Promise<BranchResult>[] = jobs.map(j => reviewer(j.name, j.prompt));
  tasks.push(deterministic());
  const results = await Promise.all(tasks);

  // ---- 2. ONE flat ERROR POOL. PASS results are dropped here. ----
  const detBranch = results.find(r => r.source === 'deterministic')!;
  const det: DeterministicResult = detBranch.det ?? { findings: [], passed: [], wordCount: countWords(output) };
  const pool: PoolEntry[] = det.findings.map((f, i): DeterministicEntry => ({
    id: `D${i + 1}`, source: 'deterministic', type: 'structural',
    requestEvidence: f.requirementQuote || f.requirement || '', outputEvidence: f.passage?.text || '', reason: f.reason,
  }));
  let n = 0;
  for (const r of results) {
    if (r.failure) failures.push(r.failure);
    if (r.source === 'deterministic') { if (!r.failure && det.findings.length === 0) bump(counts, 'deterministic_pass'); continue; }
    if (r.issues.length === 0) { if (!r.failure) bump(counts, 'reviewer_pass'); continue; }
    for (const x of r.issues) pool.push({ id: `E${++n}`, source: r.source, type: x.type, requestEvidence: x.requestEvidence, outputEvidence: x.outputEvidence, reason: x.reason, inferredTask: x.inferredTask });
    bump(counts, `candidates_${r.source}`, r.issues.length);
  }
  const candidates = pool.filter(isSemantic);
  bump(counts, 'pool_size', pool.length);
  const base = { passedChecks: det.passed, wordCount: det.wordCount, failures, notes, counts };
  // No reviewer error: nothing to adjudicate, no model call. Deterministic failures are already proven by code.
  if (candidates.length === 0) return { findings: det.findings, ...base };

  // ---- 3. ADJUDICATOR: resolves the candidates only ----------------------
  notify('confirming');
  const proven: ProvenFailureForContext[] = pool.filter(e => !isSemantic(e)).map(e => ({ id: e.id, reason: e.reason, passage: e.outputEvidence }));
  const known = new Set(pool.map(e => e.id));
  let adj: StageOutcome<Decision[]>;
  if (!providers.adjudicator) { recordSkipped('adjudicator', diagnostics); adj = { ok: false, code: 'unavailable', attempts: 0 }; }
  else adj = await runStage<Decision[]>({
    name: 'adjudicator', provider: providers.adjudicator,
    prompt: buildAdjudicatorPrompt(candidates.map(c => toPromptCandidate(c, request, output, adv)), proven, request, output, measured),
    desiredMs: ADJUDICATOR_MS, deadline: t0 + budgetMs, maxTokens: 2400, diagnostics,
    validate: makeAdjudicatorValidator(candidates.map(c => c.id), known),
  });
  if (!adj.ok) failures.push(adj.code);
  else if (adj.partial) failures.push('incomplete_adjudication');
  const decisions = new Map<string, Decision>((adj.ok ? adj.value : []).map(d => [d.id, d]));

  // A duplicate is honoured only if what it points at survives (a deterministic failure, or a kept, non-duplicate candidate).
  const honoured = (d: Decision): boolean => {
    if (!d.duplicateOf) return false;
    const t = decisions.get(d.duplicateOf);
    if (!t) return d.duplicateOf.startsWith('D');
    return t.verdict !== 'rejected' && !t.duplicateOf;
  };

  const semantic: Finding[] = [];
  // Deterministic identity used ONLY for candidates the adjudicator did not decide (no model call): the same exact
  // grounded span, or the same category + request evidence for a passage-less omission, is one user-facing finding.
  // Seeded with the deterministic findings and every adjudicated finding, so an undecided candidate can never
  // re-report what code already proved or what the adjudicator already resolved.
  const seen = new Set<string>(det.findings.filter(f => f.passage).map(f => `p:${f.passage!.start}:${f.passage!.end}`));
  const keyOf = (f: Finding) => (f.passage ? `p:${f.passage.start}:${f.passage.end}` : `o:${f.category}:${f.requirementQuote ?? f.reason}`);
  // Adjudicated candidates first, so the undecided ones are checked against them.
  const ordered = [...candidates].sort((a, b) => Number(!decisions.has(a.id)) - Number(!decisions.has(b.id)));
  for (const c of ordered) {
    const d = decisions.get(c.id);
    if (!d) {
      const f = materialize(c, null, ctx, 'uncertain');   // no usable decision: never silently dropped, never "confirmed"
      if (seen.has(keyOf(f))) { bump(counts, 'unadjudicated_deduped'); continue; }
      seen.add(keyOf(f));
      bump(counts, 'unadjudicated');
      semantic.push(f);
      continue;
    }
    if (d.verdict === 'rejected') { bump(counts, 'adjudicator_rejected'); continue; }
    if (honoured(d)) { bump(counts, 'duplicates_consolidated'); continue; }
    const f = materialize(c, d, ctx, d.verdict === 'confirmed' ? 'confirmed' : 'uncertain');
    if (f.passage) seen.add(keyOf(f));
    semantic.push(f);
  }
  return { findings: [...det.findings, ...semantic], ...base };
}
