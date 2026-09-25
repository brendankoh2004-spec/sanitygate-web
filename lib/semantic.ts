/**
 * Semantic review — primary reasoning engine.
 *
 * Pipeline:
 *
 *   analysing
 *      deterministic request ledger
 *
 *   reviewing
 *      evaluator -> requirement-by-requirement judgments
 *
 *   verifying
 *      VERIFY + independent SCAN in parallel
 *
 * Design goals:
 * - Never let optional extraction make the whole review incomplete.
 * - Preserve a deterministic requirement ledger.
 * - Keep enough time for VERIFY + SCAN.
 * - Require complete evaluator coverage.
 * - Require independent verifier grounding.
 * - Never display model-generated quotes directly; all displayed evidence
 *   is sliced from the real REQUEST / OUTPUT.
 */

import {
  Finding,
  FindingCategory,
  FindingOrigin,
  FindingVerification,
  RequirementItem,
  RequirementKind,
  RequirementCategory,
  Severity,
  TextEdit,
  AdditionalChecks,
  StageDiagnostic,
} from './types';

import { LLMProvider } from './llm/provider';

import {
  findSpan,
  sameLocation,
  spanOverlap,
  splitSentences,
  Span,
} from './evidence';

import { runStage, Validated } from './stage';

import {
  buildExtractionPrompt,
  buildEvaluatorPrompt,
  buildVerifyPrompt,
  buildScanPrompt,
  ClaimForVerification,
} from './prompts';

import {
  countWords,
  countListItems,
} from './validators/deterministic';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const str = (x: unknown, max = 600): string =>
  typeof x === 'string' ? x.trim().slice(0, max) : '';

const asObj = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? x as Record<string, unknown>
    : null;

const oneOf = <T extends string>(
  x: unknown,
  allowed: readonly T[],
): T | null =>
  typeof x === 'string' &&
  (allowed as readonly string[]).includes(x)
    ? x as T
    : null;

type SemCategory = Exclude<FindingCategory, 'structural'>;

const SEM_CATEGORIES = [
  'instruction_violation',
  'factual_contradiction',
  'unsupported_addition',
  'omission',
] as const;

const JUDGE_CATEGORIES = [
  'instruction_violation',
  'factual_contradiction',
  'omission',
] as const;

const SUBJECTS = [
  'yes',
  'no',
  'unclear',
  'n/a',
] as const;

type Subject = typeof SUBJECTS[number];

interface RawFix {
  original: string;
  replacement: string;
  insertAfter: string;
}

function parseFix(x: unknown): RawFix | null {
  const o = asObj(x);
  if (!o) return null;

  const f: RawFix = {
    original: str(o.original, 1000),
    replacement: str(o.replacement, 800),
    insertAfter: str(o.insert_after, 1000),
  };

  return f.original || f.insertAfter ? f : null;
}

// ---------------------------------------------------------------------
// Raw model finding
// ---------------------------------------------------------------------

interface RawFinding {
  category: SemCategory;
  severity: Severity;
  outputQuote: string;
  requestQuote: string;
  requirement: string;
  reason: string;
  fix: RawFix | null;
  capped: boolean;
}

// ---------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------

export const MAX_LEDGER_ITEMS = 60;

const KINDS = [
  'instruction',
  'fact',
] as const;

const CATS = [
  'content',
  'prohibition',
  'format',
  'quantity',
  'order',
  'length',
  'other',
] as const;

interface RawItem {
  kind: RequirementKind;
  category: RequirementCategory;
  text: string;
  quote: string;
}

function validateExtraction(
  raw: unknown,
): Validated<RawItem[]> | null {
  const o = asObj(raw);

  if (!o || !Array.isArray(o.items)) {
    return null;
  }

  const items: RawItem[] = [];

  for (const it of o.items) {
    const r = asObj(it);

    const kind =
      r && oneOf(r.kind, KINDS);

    if (!r || !kind || !str(r.quote)) {
      continue;
    }

    items.push({
      kind,
      category:
        oneOf(r.category, CATS) || 'other',
      text: str(r.text, 300),
      quote: str(r.quote, 600),
    });
  }

  return {
    value: items,
    complete: true,
  };
}

/**
 * Build a deterministic ledger from the request.
 *
 * IMPORTANT:
 * This is now the safety-critical path.
 *
 * The LLM extraction step is optional enrichment only. If it fails,
 * the review still has a complete sentence-based ledger.
 */
export function buildLedger(
  request: string,
  extracted: RawItem[] | null,
  ctaRequired: boolean,
): {
  items: RequirementItem[];
  truncated: boolean;
  dropped: number;
} {
  const items: Omit<RequirementItem, 'id'>[] = [];

  let dropped = 0;

  // ---------------------------------------------------------------
  // Use validated extraction items when available.
  // ---------------------------------------------------------------

  for (const r of extracted || []) {
    const m = findSpan(request, r.quote);

    if (!m.found || m.start == null || m.end == null) {
      dropped++;
      continue;
    }

    items.push({
      kind: r.kind,
      category: r.category,
      text:
        r.text ||
        request.slice(m.start, m.end),
      quote: request.slice(m.start, m.end),
      quoteStart: m.start,
      quoteEnd: m.end,
    });
  }

  // ---------------------------------------------------------------
  // Coverage fill.
  //
  // Any sentence not substantially covered by an extracted item is
  // added deterministically. This guarantees that failed extraction
  // cannot silently remove request content.
  // ---------------------------------------------------------------

  const spans: Span[] = items
    .map(i => ({
      start: i.quoteStart!,
      end: i.quoteEnd!,
    }))
    .sort((a, b) => a.start - b.start);

  for (const s of splitSentences(request)) {
    if (s.end - s.start < 8) {
      continue;
    }

    const covered = spans.reduce(
      (n, sp) => n + spanOverlap(sp, s),
      0,
    );

    if (
      covered / (s.end - s.start) >= 0.5
    ) {
      continue;
    }

    items.push({
      kind: 'unclassified',
      category: null,
      text: request
        .slice(s.start, s.end)
        .slice(0, 300),
      quote: request.slice(s.start, s.end),
      quoteStart: s.start,
      quoteEnd: s.end,
    });
  }

  items.sort(
    (a, b) =>
      (a.quoteStart ?? 0) -
      (b.quoteStart ?? 0),
  );

  let truncated = false;

  let kept = items;

  if (kept.length > MAX_LEDGER_ITEMS) {
    kept = kept.slice(0, MAX_LEDGER_ITEMS);
    truncated = true;
  }

  if (ctaRequired) {
    kept.push({
      kind: 'instruction',
      category: 'content',
      text:
        'The output must include a clear call to action.',
      quote: '',
      quoteStart: null,
      quoteEnd: null,
    });
  }

  return {
    items: kept.map((it, i) => ({
      ...it,
      id: `R${i + 1}`,
    })),
    truncated,
    dropped,
  };
}

// ---------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------

const VERDICTS = [
  'satisfied',
  'violated',
  'not_applicable',
  'unclear',
] as const;

interface Judgment {
  id: string;
  verdict: typeof VERDICTS[number];

  category: string;
  severity: Severity;

  outputQuote: string;

  // IMPORTANT:
  // These fields were requested by the prompt but previously discarded.
  requestSubject: string;
  outputSubject: string;

  sameSubject: Subject | null;

  notEquivalentBecause: string;
  reason: string;

  fix: RawFix | null;
}

interface EvalParsed {
  judgments: Judgment[];
  unrequested: RawFinding[];
}

function parseUnrequested(
  arr: unknown[],
): RawFinding[] {
  const out: RawFinding[] = [];

  for (const u of arr) {
    const o = asObj(u);

    if (!o || !str(o.output_quote)) {
      continue;
    }

    out.push({
      category: 'unsupported_addition',

      severity:
        o.severity === 'critical'
          ? 'critical'
          : 'warning',

      outputQuote:
        str(o.output_quote, 1000),

      requestQuote:
        str(o.request_quote, 1000),

      requirement: '',

      reason:
        str(o.reason, 400) ||
        'This claim is not supported by the request.',

      fix: parseFix(o.fix),

      capped: false,
    });
  }

  return out;
}

function makeEvaluatorValidator(
  ids: string[],
  includeUnrequested: boolean,
) {
  return (
    raw: unknown,
  ): Validated<EvalParsed> | null => {
    const o = asObj(raw);

    if (
      !o ||
      !Array.isArray(o.judgments)
    ) {
      return null;
    }

    const seen = new Set<string>();

    const judgments: Judgment[] = [];

    for (const j of o.judgments) {
      const r = asObj(j);

      const id =
        r ? str(r.id, 20) : '';

      const verdict =
        r &&
        oneOf(r.verdict, VERDICTS);

      if (
        !r ||
        !verdict ||
        !ids.includes(id) ||
        seen.has(id)
      ) {
        continue;
      }

      seen.add(id);

      judgments.push({
        id,
        verdict,

        category:
          str(r.category, 40),

        severity:
          r.severity === 'critical'
            ? 'critical'
            : 'warning',

        outputQuote:
          str(r.output_quote, 1000),

        requestSubject:
          str(r.request_subject, 500),

        outputSubject:
          str(r.output_subject, 500),

        sameSubject:
          oneOf(
            r.same_subject,
            SUBJECTS,
          ),

        notEquivalentBecause:
          str(
            r.not_equivalent_because,
            400,
          ),

        reason:
          str(r.reason, 400),

        fix:
          parseFix(r.fix),
      });
    }

    const unreqOk =
      !includeUnrequested ||
      Array.isArray(o.unrequested);

    const unrequested =
      Array.isArray(o.unrequested)
        ? parseUnrequested(o.unrequested)
        : [];

    return {
      value: {
        judgments,
        unrequested,
      },

      complete:
        ids.every(id =>
          seen.has(id),
        ) && unreqOk,
    };
  };
}

/**
 * Convert evaluator judgment into a candidate.
 *
 * No issue is accepted simply because the evaluator says "violated".
 * Local grounding rules still apply.
 */
function judgmentToCandidate(
  j: Judgment,
  item: RequirementItem,
  counts: Record<string, number>,
): RawFinding | null {
  if (
    j.verdict !== 'violated' &&
    j.verdict !== 'unclear'
  ) {
    return null;
  }

  if (
    j.verdict === 'unclear' &&
    !j.reason
  ) {
    bump(
      counts,
      'eval_unclear_without_reason',
    );

    return null;
  }

  const category: SemCategory =
    oneOf(
      j.category,
      JUDGE_CATEGORIES,
    ) ||
    (
      item.kind === 'fact'
        ? 'factual_contradiction'
        : 'instruction_violation'
    );

  let capped =
    j.verdict === 'unclear';

  if (
    category ===
    'factual_contradiction'
  ) {
    if (j.sameSubject === 'no') {
      bump(
        counts,
        'eval_dropped_different_referent',
      );

      return null;
    }

    if (j.sameSubject !== 'yes') {
      capped = true;
    }
  }

  if (
    j.verdict === 'violated' &&
    !j.notEquivalentBecause
  ) {
    capped = true;
  }

  return {
    category,
    severity: j.severity,

    outputQuote:
      j.outputQuote,

    requestQuote:
      item.quote,

    requirement:
      item.text,

    reason:
      j.reason ||
      'The output does not match the request here.',

    fix:
      j.fix,

    capped,
  };
}

// ---------------------------------------------------------------------
// VERIFY / SCAN parsing
// ---------------------------------------------------------------------

type Verdict =
  | 'confirmed'
  | 'rejected'
  | 'uncertain';

interface Verification {
  cid: string;

  requestQuote: string;
  outputQuote: string;

  sameSubject: Subject | null;

  verdict: Verdict;

  fixOk: boolean;
  betterFix: RawFix | null;
}

function makeVerifyValidator(
  cids: string[],
) {
  return (
    raw: unknown,
  ): Validated<Verification[]> | null => {
    const o = asObj(raw);

    if (
      !o ||
      !Array.isArray(o.verifications)
    ) {
      return null;
    }

    const seen = new Set<string>();
    const out: Verification[] = [];

    for (const v of o.verifications) {
      const r = asObj(v);

      const cid =
        r ? str(r.cid, 20) : '';

      const verdict =
        r &&
        oneOf(
          r.verdict,
          [
            'confirmed',
            'rejected',
            'uncertain',
          ] as const,
        );

      if (
        !r ||
        !verdict ||
        !cids.includes(cid) ||
        seen.has(cid)
      ) {
        continue;
      }

      seen.add(cid);

      out.push({
        cid,

        requestQuote:
          str(
            r.request_quote,
            1000,
          ),

        outputQuote:
          str(
            r.output_quote,
            1000,
          ),

        sameSubject:
          oneOf(
            r.same_subject,
            SUBJECTS,
          ),

        verdict,

        fixOk:
          r.fix_ok !== false,

        betterFix:
          parseFix(r.better_fix),
      });
    }

    return {
      value: out,

      complete:
        cids.every(cid =>
          seen.has(cid),
        ),
    };
  };
}

function validateScan(
  raw: unknown,
): Validated<RawFinding[]> | null {
  const o = asObj(raw);

  if (
    !o ||
    !Array.isArray(o.findings)
  ) {
    return null;
  }

  const out: RawFinding[] = [];

  for (
    const f of o.findings.slice(0, 5)
  ) {
    const r = asObj(f);

    const category =
      r &&
      oneOf(
        r.category,
        SEM_CATEGORIES,
      );

    if (!r || !category) {
      continue;
    }

    const sameSubject =
      oneOf(
        r.same_subject,
        SUBJECTS,
      );

    // Different subject = not a factual contradiction.
    if (
      category ===
        'factual_contradiction' &&
      sameSubject === 'no'
    ) {
      continue;
    }

    let capped = false;

    if (
      category ===
        'factual_contradiction' &&
      sameSubject !== 'yes'
    ) {
      capped = true;
    }

    if (
      !str(
        r.not_equivalent_because,
      )
    ) {
      capped = true;
    }

    const outputQuote =
      str(
        r.output_quote,
        1000,
      );

    if (
      category !== 'omission' &&
      !outputQuote
    ) {
      continue;
    }

    out.push({
      category,

      severity:
        r.severity === 'critical'
          ? 'critical'
          : 'warning',

      outputQuote,

      requestQuote:
        str(
          r.request_quote,
          1000,
        ),

      requirement: '',

      reason:
        str(r.reason, 400) ||
        'Possible material mismatch.',

      fix:
        parseFix(r.fix),

      capped,
    });
  }

  return {
    value: out,
    complete: true,
  };
}

const bump = (
  c: Record<string, number>,
  k: string,
  n = 1,
) => {
  c[k] = (c[k] || 0) + n;
};

// ---------------------------------------------------------------------
// Evidence location
// ---------------------------------------------------------------------

interface Located {
  out: Span | null;
  outAmbiguous: boolean;
  req: Span | null;
}

function locate(
  raw: RawFinding,
  request: string,
  output: string,
): Located {
  const o =
    raw.outputQuote
      ? findSpan(
          output,
          raw.outputQuote,
        )
      : null;

  const r =
    raw.requestQuote
      ? findSpan(
          request,
          raw.requestQuote,
        )
      : null;

  return {
    out:
      o?.found
        ? {
            start: o.start!,
            end: o.end!,
          }
        : null,

    outAmbiguous:
      !!o &&
      o.occurrences > 1,

    req:
      r?.found
        ? {
            start: r.start!,
            end: r.end!,
          }
        : null,
  };
}

function buildEdit(
  fix: RawFix | null,
  passage: Span | null,
  output: string,
): TextEdit | null {
  if (!fix) {
    return null;
  }

  if (fix.insertAfter) {
    const m =
      findSpan(
        output,
        fix.insertAfter,
      );

    if (
      !m.found ||
      m.occurrences !== 1 ||
      !fix.replacement
    ) {
      return null;
    }

    const before =
      output.slice(
        0,
        m.end!,
      );

    const glue =
      /\s$/.test(before) ||
      /^[\s.,;:!?)]/.test(
        fix.replacement,
      )
        ? ''
        : ' ';

    return {
      start: m.end!,
      end: m.end!,
      original: '',
      replacement:
        glue +
        fix.replacement,
    };
  }

  const m =
    findSpan(
      output,
      fix.original,
    );

  if (
    !m.found ||
    m.occurrences !== 1
  ) {
    return null;
  }

  if (
    passage &&
    spanOverlap(
      passage,
      {
        start: m.start!,
        end: m.end!,
      },
    ) === 0
  ) {
    return null;
  }

  const original =
    output.slice(
      m.start!,
      m.end!,
    );

  if (
    original ===
    fix.replacement
  ) {
    return null;
  }

  return {
    start: m.start!,
    end: m.end!,
    original,
    replacement:
      fix.replacement,
  };
}

// ---------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------

function materialize(
  raw: RawFinding,
  loc: Located,
  request: string,
  output: string,
  meta: {
    origin: FindingOrigin;
    verification: FindingVerification;
    strength:
      | 'confirmed'
      | 'uncertain';
    fix?: RawFix | null;
  },
): Finding {
  let strength =
    meta.strength;

  const passage =
    loc.out
      ? {
          start: loc.out.start,
          end: loc.out.end,
          text: output.slice(
            loc.out.start,
            loc.out.end,
          ),
        }
      : null;

  const requirementQuote =
    loc.req
      ? request.slice(
          loc.req.start,
          loc.req.end,
        )
      : null;

  if (
    raw.outputQuote &&
    !passage
  ) {
    strength = 'uncertain';
  }

  if (
    raw.requestQuote &&
    !requirementQuote
  ) {
    strength = 'uncertain';
  }

  if (
    raw.category !== 'omission' &&
    !passage
  ) {
    strength = 'uncertain';
  }

  if (
    raw.category === 'omission' &&
    !requirementQuote
  ) {
    strength = 'uncertain';
  }

  const fix =
    meta.fix === undefined
      ? raw.fix
      : meta.fix;

  const edit =
    loc.outAmbiguous &&
    !fix?.insertAfter
      ? null
      : buildEdit(
          fix,
          loc.out,
          output,
        );

  return {
    id: 'tmp',

    category:
      raw.category,

    severity:
      raw.severity,

    strength,

    origin:
      meta.origin,

    verification:
      meta.verification,

    passage,

    requirementQuote,

    requirement:
      raw.requirement || null,

    reason:
      raw.reason,

    suggestion:
      edit
        ? edit.replacement
        : (
            fix?.replacement ||
            null
          ),

    edit,
  };
}

// ---------------------------------------------------------------------
// VERIFY grounding
// ---------------------------------------------------------------------

function groundVerdict(
  v: Verification,
  cand: RawFinding,
  candLoc: Located,
  request: string,
  output: string,
  counts: Record<string, number>,
): Verdict {
  let verdict = v.verdict;

  if (
    verdict !== 'confirmed'
  ) {
    return verdict;
  }

  if (
    cand.category ===
    'factual_contradiction'
  ) {
    if (
      v.sameSubject === 'no'
    ) {
      return 'rejected';
    }

    if (
      v.sameSubject !== 'yes'
    ) {
      verdict = 'uncertain';
    }
  }

  const vOut =
    v.outputQuote
      ? findSpan(
          output,
          v.outputQuote,
        )
      : null;

  const vReq =
    v.requestQuote
      ? findSpan(
          request,
          v.requestQuote,
        )
      : null;

  const outOk =
    cand.category === 'omission' ||
    !!vOut?.found;

  const reqOk =
    cand.category ===
      'unsupported_addition' ||
    !!vReq?.found;

  if (
    !outOk ||
    !reqOk
  ) {
    bump(
      counts,
      'verify_ungrounded_confirmation',
    );

    return 'uncertain';
  }

  // The verifier must point to the same output passage.
  if (
    vOut?.found &&
    candLoc.out &&
    !sameLocation(
      {
        start: vOut.start!,
        end: vOut.end!,
      },
      candLoc.out,
    )
  ) {
    bump(
      counts,
      'verify_different_location',
    );

    return 'uncertain';
  }

  return verdict;
}

function sameIssue(
  a: Located,
  b: Located,
): boolean {
  if (
    a.out &&
    b.out
  ) {
    return sameLocation(
      a.out,
      b.out,
    );
  }

  if (
    !a.out &&
    !b.out &&
    a.req &&
    b.req
  ) {
    return sameLocation(
      a.req,
      b.req,
    );
  }

  return false;
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

export interface SemanticParams {
  providers: {
    extraction: LLMProvider;
    evaluator: LLMProvider;
    verifier: LLMProvider;
  };

  request: string;
  output: string;
  adv: AdditionalChecks;

  t0: number;
  budgetMs: number;

  diagnostics: StageDiagnostic[];

  onStage?: (
    s:
      | 'analysing'
      | 'reviewing'
      | 'verifying',
  ) => void;
}

export interface SemanticOutcome {
  findings: Finding[];
  requirements: RequirementItem[];

  /**
   * Empty means all required semantic stages completed.
   *
   * Optional extraction is deliberately NOT allowed to make this
   * non-empty.
   */
  failures: string[];

  notes: string[];

  counts: Record<string, number>;
}

// ---------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------

/**
 * Larger batches = fewer simultaneous LLM requests.
 *
 * 3 was causing many parallel evaluator calls.
 * 6 gives substantially better reliability while still keeping
 * the prompt manageable.
 */
const EVAL_BATCH = () =>
  Math.max(
    1,
    Number(
      process.env.EVALUATOR_BATCH_SIZE,
    ) || 6,
  );

/**
 * Keep verification manageable.
 */
const MAX_CLAIMS = 20;

/**
 * Extraction is optional enrichment.
 *
 * Do NOT make it part of the critical path unless there is enough
 * total time to actually use it.
 */
const EXTRACTION_MIN_BUDGET_MS = 40000;

const EXTRACTION_STAGE_MS = 5000;

/**
 * VERIFY + SCAN need a protected window.
 *
 * They run in parallel, so this is the maximum time reserved for
 * the slower of the two.
 */
const VERIFICATION_RESERVE_MS = 12000;

/**
 * Minimum useful evaluation window.
 */
const MIN_EVALUATION_MS = 8000;

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

export async function runSemanticReview(
  p: SemanticParams,
): Promise<SemanticOutcome> {
  const {
    providers,
    request,
    output,
    adv,
    t0,
    budgetMs,
    diagnostics,
  } = p;

  const failures: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = {};

  const hasRequest =
    !!request.trim();

  const measured = {
    wordCount:
      countWords(output),

    listItems:
      countListItems(output),
  };

  const finalDeadline =
    t0 + budgetMs;

  // ---------------------------------------------------------------
  // Calculate the protected windows.
  // ---------------------------------------------------------------

  const verificationReserve =
    Math.min(
      VERIFICATION_RESERVE_MS,
      Math.max(
        6000,
        Math.floor(
          budgetMs * 0.4,
        ),
      ),
    );

  const reviewDeadline =
    finalDeadline -
    verificationReserve;

  // ---------------------------------------------------------------
  // ANALYSING
  // ---------------------------------------------------------------

  p.onStage?.('analysing');

  let extracted:
    RawItem[] | null = null;

  /**
   * IMPORTANT:
   *
   * Do not run extraction for normal short-budget reviews.
   *
   * The deterministic sentence ledger is already capable of complete
   * coverage and avoids burning 8–18 seconds before evaluation.
   */
  const enoughTimeForExtraction =
    hasRequest &&
    budgetMs >=
      EXTRACTION_MIN_BUDGET_MS;

  if (
    enoughTimeForExtraction
  ) {
    const extractionDeadline =
      Math.min(
        t0 +
          EXTRACTION_STAGE_MS,
        reviewDeadline -
          MIN_EVALUATION_MS,
      );

    if (
      extractionDeadline >
      t0
    ) {
      const ex =
        await runStage<RawItem[]>({
          name:
            'extraction',

          provider:
            providers.extraction,

          prompt:
            buildExtractionPrompt(
              request,
            ),

          desiredMs:
            EXTRACTION_STAGE_MS,

          deadline:
            extractionDeadline,

          maxTokens:
            1600,

          diagnostics,

          validate:
            validateExtraction,
        });

      if (ex.ok) {
        extracted =
          ex.value;
      } else {
        /**
         * This is deliberately a NOTE, not a FAILURE.
         *
         * The deterministic ledger still gives us full coverage.
         */
        notes.push(
          'optional_extraction_unavailable_using_deterministic_ledger',
        );

        bump(
          counts,
          'extraction_failed',
        );
      }
    }
  } else if (hasRequest) {
    notes.push(
      'deterministic_ledger_used',
    );
  }

  // ---------------------------------------------------------------
  // LEDGER
  // ---------------------------------------------------------------

  const ledger =
    buildLedger(
      request,
      extracted,
      adv.cta,
    );

  if (
    ledger.dropped
  ) {
    bump(
      counts,
      'ledger_dropped_unverifiable_items',
      ledger.dropped,
    );
  }

  if (
    ledger.truncated
  ) {
    failures.push(
      'ledger_truncated',
    );
  }

  const requirements =
    ledger.items;

  // ---------------------------------------------------------------
  // REVIEWING
  // ---------------------------------------------------------------

  p.onStage?.('reviewing');

  const size =
    EVAL_BATCH();

  const batches:
    RequirementItem[][] = [];

  for (
    let i = 0;
    i < requirements.length;
    i += size
  ) {
    batches.push(
      requirements.slice(
        i,
        i + size,
      ),
    );
  }

  const evalCands:
    RawFinding[] = [];

  let evaluatorProblem:
    string | null = null;

  if (
    batches.length === 0
  ) {
    evaluatorProblem =
      'no_requirements';
  } else {
    /**
     * All batches run concurrently.
     *
     * The shared absolute deadline means they cannot individually
     * extend beyond the protected verification window.
     */
    const outcomes =
      await Promise.all(
        batches.map(
          (batch, bi) =>
            runStage<EvalParsed>({
              name:
                batches.length > 1
                  ? `evaluator[${bi + 1}/${batches.length}]`
                  : 'evaluator',

              provider:
                providers.evaluator,

              prompt:
                buildEvaluatorPrompt(
                  request,
                  output,
                  batch,
                  measured,
                  bi === 0,
                ),

              desiredMs:
                Math.min(
                  9000,
                  Math.max(
                    6000,
                    reviewDeadline -
                      Date.now(),
                  ),
                ),

              deadline:
                reviewDeadline,

              maxTokens:
                2200,

              diagnostics,

              validate:
                makeEvaluatorValidator(
                  batch.map(
                    b => b.id,
                  ),
                  bi === 0,
                ),
            }),
        ),
      );

    outcomes.forEach(
      (o, bi) => {
        if (!o.ok) {
          evaluatorProblem =
            evaluatorProblem ||
            o.code;

          return;
        }

        if (o.partial) {
          evaluatorProblem =
            evaluatorProblem ||
            'incomplete_coverage';
        }

        for (
          const j of
          o.value.judgments
        ) {
          const item =
            batches[bi].find(
              b =>
                b.id === j.id,
            );

          if (!item) {
            continue;
          }

          const c =
            judgmentToCandidate(
              j,
              item,
              counts,
            );

          if (c) {
            evalCands.push(c);
          }

          if (
            j.verdict ===
              'satisfied' &&
            j.outputQuote &&
            !findSpan(
              output,
              j.outputQuote,
            ).found
          ) {
            bump(
              counts,
              'eval_satisfied_quote_unfound',
            );
          }
        }

        evalCands.push(
          ...o.value.unrequested,
        );
      },
    );
  }

  /**
   * IMPORTANT:
   *
   * Only an evaluator coverage problem is a real failure.
   * Extraction failure is deliberately not here.
   */
  if (evaluatorProblem) {
    failures.push(
      evaluatorProblem,
    );
  }

  bump(
    counts,
    'eval_candidates',
    evalCands.length,
  );

  // ---------------------------------------------------------------
  // VERIFY + SCAN
  // ---------------------------------------------------------------

  p.onStage?.('verifying');

  const capped =
    evalCands.slice(
      0,
      MAX_CLAIMS,
    );

  if (
    evalCands.length >
    MAX_CLAIMS
  ) {
    failures.push(
      'verify_overflow',
    );
  }

  const evalLocs =
    evalCands.map(c =>
      locate(
        c,
        request,
        output,
      ),
    );

  const claims:
    ClaimForVerification[] =
    capped.map(
      (c, i) => ({
        cid:
          `C${i + 1}`,

        category:
          c.category,

        requirement:
          c.requirement,

        requestQuote:
          c.requestQuote,

        outputQuote:
          c.outputQuote,

        proposedOriginal:
          c.fix?.original ||
          c.fix?.insertAfter ||
          '',

        proposedReplacement:
          c.fix?.replacement ||
          '',
      }),
    );

  /**
   * VERIFY and SCAN intentionally run in parallel.
   *
   * This is important: serial verification would double the
   * latency and make timeout failures much more likely.
   */
  const [
    verifyOut,
    scanOut,
  ] =
    await Promise.all([
      claims.length
        ? runStage<Verification[]>({
            name:
              'verify',

            provider:
              providers.verifier,

            prompt:
              buildVerifyPrompt(
                claims,
                request,
                output,
              ),

            desiredMs:
              Math.min(
                9000,
                Math.max(
                  6000,
                  finalDeadline -
                    Date.now(),
                ),
              ),

            deadline:
              finalDeadline,

            maxTokens:
              1800,

            diagnostics,

            validate:
              makeVerifyValidator(
                claims.map(
                  c => c.cid,
                ),
              ),
          })
        : Promise.resolve(
            null,
          ),

      runStage<RawFinding[]>({
        name:
          'scan',

        provider:
          providers.verifier,

        prompt:
          buildScanPrompt(
            request,
            output,
            measured,
            adv.cta,
          ),

        desiredMs:
          Math.min(
            9000,
            Math.max(
              6000,
              finalDeadline -
                Date.now(),
            ),
          ),

        deadline:
          finalDeadline,

        maxTokens:
          900,

        diagnostics,

        validate:
          validateScan,
      }),
    ]);

  // ---------------------------------------------------------------
  // Verification status
  // ---------------------------------------------------------------

  if (verifyOut) {
    if (!verifyOut.ok) {
      failures.push(
        verifyOut.code,
      );
    } else if (
      verifyOut.partial
    ) {
      failures.push(
        'incomplete_verification',
      );
    }
  }

  if (!scanOut.ok) {
    failures.push(
      scanOut.code,
    );
  } else if (
    scanOut.partial
  ) {
    failures.push(
      'incomplete_scan',
    );
  }

  const verifyList:
    Verification[] =
    verifyOut &&
    verifyOut.ok
      ? verifyOut.value
      : [];

  const scanCands:
    RawFinding[] =
    scanOut.ok
      ? scanOut.value
      : [];

  const scanLocs =
    scanCands.map(s =>
      locate(
        s,
        request,
        output,
      ),
    );

  bump(
    counts,
    'scan_findings',
    scanCands.length,
  );

  // ---------------------------------------------------------------
  // COMBINE
  // ---------------------------------------------------------------

  const findings:
    Finding[] = [];

  const scanUsed =
    new Set<number>();

  evalCands.forEach(
    (cand, i) => {
      const loc =
        evalLocs[i];

      const claimIdx =
        i < MAX_CLAIMS
          ? i
          : -1;

      const v =
        claimIdx >= 0
          ? verifyList.find(
              x =>
                x.cid ===
                `C${claimIdx + 1}`,
            )
          : undefined;

      const verdict:
        | Verdict
        | 'missing' =
        v
          ? groundVerdict(
              v,
              cand,
              loc,
              request,
              output,
              counts,
            )
          : 'missing';

      let scanIdx =
        -1;

      scanLocs.forEach(
        (sl, k) => {
          if (
            scanIdx < 0 &&
            sameIssue(
              loc,
              sl,
            )
          ) {
            scanIdx = k;
          }
        },
      );

      const corroborated =
        scanIdx >= 0;

      if (corroborated) {
        scanUsed.add(
          scanIdx,
        );

        bump(
          counts,
          'scan_corroborated',
        );
      }

      const clean =
        corroborated &&
        !cand.capped &&
        !scanCands[
          scanIdx
        ].capped;

      let strength:
        | 'confirmed'
        | 'uncertain';

      let verification:
        FindingVerification;

      if (
        verdict ===
        'confirmed'
      ) {
        strength =
          'confirmed';

        verification =
          'confirmed';
      } else if (
        verdict ===
        'rejected'
      ) {
        if (
          !corroborated
        ) {
          bump(
            counts,
            'eval_rejected_by_verifier',
          );

          return;
        }

        strength =
          'uncertain';

        verification =
          'rejected_corroborated';
      } else if (
        verdict ===
        'uncertain'
      ) {
        strength =
          clean
            ? 'confirmed'
            : 'uncertain';

        verification =
          'uncertain';
      } else {
        strength =
          clean
            ? 'confirmed'
            : 'uncertain';

        verification =
          'unverified';
      }

      let fix =
        cand.fix;

      if (
        v &&
        !v.fixOk
      ) {
        fix =
          v.betterFix;
      }

      findings.push(
        materialize(
          cand,
          loc,
          request,
          output,
          {
            origin:
              corroborated
                ? 'evaluator+scan'
                : 'evaluator',

            verification,

            strength,

            fix,
          },
        ),
      );
    },
  );

  // ---------------------------------------------------------------
  // Scan-only findings
  // ---------------------------------------------------------------

  scanCands.forEach(
    (s, k) => {
      if (
        scanUsed.has(k)
      ) {
        return;
      }

      bump(
        counts,
        'scan_only_findings',
      );

      findings.push(
        materialize(
          s,
          scanLocs[k],
          request,
          output,
          {
            origin:
              'verifier_scan',

            verification:
              'scan_only',

            strength:
              'uncertain',
          },
        ),
      );
    },
  );

  return {
    findings,
    requirements,
    failures,
    notes,
    counts,
  };
}
