import { Finding, AdditionalChecks } from '../types';

function idFor(prefix: string): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export function mkFinding(f: Partial<Finding> & Pick<Finding, 'type' | 'reason'>): Finding {
  return {
    id: idFor('f'), severity: 'warning', confidence: 1, source: 'deterministic',
    start: null, end: null, matchedText: null, evidence: null, requirement: null,
    suggestion: null, suggestionVerified: true, status: 'open', userVerdict: null,
    needsReview: false, evidenceValidated: true,
    ...f,
  };
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[\s*(insert[^\]]*|todo|tbd|placeholder|company\s*name|customer\s*name|client\s*name|your\s*name|full\s*name|date|link|url|phone|email)\s*\]/gi,
  /\{\{\s*[\w.\- ]{1,40}\s*\}\}/g,
  /<\s*(insert[^>]*|company\s*name|customer\s*name|client\s*name|your\s*name|full\s*name)\s*>/gi,
  /\bXXX+\b/g,
];

function detectPlaceholders(text: string) {
  const out: { start: number; end: number; text: string }[] = [];
  for (const re0 of PLACEHOLDER_PATTERNS) {
    const re = new RegExp(re0.source, re0.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function findOccurrences(text: string, term: string) {
  const out: { start: number; end: number; text: string }[] = [];
  if (!term) return out;
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

interface NumMatch { kind: 'money' | 'percent'; raw: string; value: number; start: number; end: number; }

// Recognizes an optional short currency-code prefix (S$, US$, A$, ...),
// the numeric amount (with optional comma grouping / decimals), and an
// optional scale word — "$0.96 million" and "$960,000" both need to
// resolve to the same numeric value, which requires actually parsing the
// scale word rather than comparing the matched substrings as text.
const MONEY_RE = /[A-Za-z]{0,3}\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?(million|billion|thousand|mn|bn)?\b/gi;
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s?%/g;

function moneyValue(numStr: string, scale?: string): number {
  let n = parseFloat(numStr.replace(/,/g, ''));
  if (scale) {
    const s = scale.toLowerCase();
    if (s.startsWith('million') || s === 'mn') n *= 1_000_000;
    else if (s.startsWith('billion') || s === 'bn') n *= 1_000_000_000;
    else if (s.startsWith('thousand')) n *= 1_000;
  }
  return n;
}

function extractNumbers(text: string): NumMatch[] {
  const out: NumMatch[] = [];
  let m: RegExpExecArray | null;
  const moneyRe = new RegExp(MONEY_RE.source, MONEY_RE.flags);
  while ((m = moneyRe.exec(text))) {
    out.push({ kind: 'money', raw: m[0].trim(), value: moneyValue(m[1], m[2]), start: m.index, end: m.index + m[0].length });
  }
  const pctRe = new RegExp(PERCENT_RE.source, PERCENT_RE.flags);
  while ((m = pctRe.exec(text))) {
    out.push({ kind: 'percent', raw: m[0].trim(), value: parseFloat(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Sentence boundary search that skips periods used as decimal points (a
// period with a digit on both sides, e.g. the "." in "$8.42") rather than
// treating every "." as a sentence end — a naive indexOf('.', ...) would
// truncate evidence for any sentence containing a decimal number.
function sentenceBounds(text: string, idx: number): { start: number; end: number } {
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') { start = i + 1; break; }
    if (ch === '.' && !(i > 0 && /\d/.test(text[i - 1]) && i + 1 < text.length && /\d/.test(text[i + 1]))) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = idx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { end = i; break; }
    if (ch === '.' && !(i > 0 && /\d/.test(text[i - 1]) && i + 1 < text.length && /\d/.test(text[i + 1]))) { end = i + 1; break; }
  }
  return { start, end };
}

// Deliberately small — just enough to keep generic connector/filler words,
// and generic reporting-cadence words like "quarter"/"year" (which appear
// in almost every business sentence and are too weak on their own to
// confidently pair two figures), from drowning out the content words
// ("revenue", "online", "discount", a plan name, ...) that actually
// distinguish one figure from another.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'with', 'by', 'from', 'that', 'this', 'it', 'its',
  'as', 'will', 'would', 'plan', 'plans', 'during', 'about', 'over', 'under', 'more', 'less', 'than',
  'compared', 'approximately', 'around', 'which', 'who', 'into', 'also', 'not', 'no', 'still', 'per',
  'quarter', 'quarterly', 'year', 'yearly', 'month', 'monthly', 'period', 'reported', 'report',
  'company', 'division', 'figure', 'figures', 'amount', 'amounted', 'reaching',
  'million', 'billion', 'thousand', 'mn', 'bn']);

// Context is scoped to the ENCLOSING SENTENCE only, not a fixed character
// window — a fixed-width window lets words from an adjacent sentence leak
// in purely by physical proximity, which can cause a false tie (or worse,
// a confident wrong match) between figures that aren't actually related.
function contextWords(text: string, numStart: number, numEnd: number): Set<string> {
  const { start } = sentenceBounds(text, numStart);
  const { end } = sentenceBounds(text, numEnd);
  const sentence = text.slice(start, end).toLowerCase();
  const words = sentence.split(/[^a-z]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

// Tolerance accounts for float rounding after scale-word multiplication,
// not for genuine differences — $8.42M vs $9.42M is well outside this.
function valuesEqual(a: number, b: number): boolean {
  const tol = Math.max(0.005, Math.max(Math.abs(a), Math.abs(b)) * 0.0005);
  return Math.abs(a - b) <= tol;
}

/** The sentence containing `idx`, for focused evidence — never a dump of
 * every number in the document. */
function sentenceAround(text: string, idx: number): string {
  const { start, end } = sentenceBounds(text, idx);
  const sentence = text.slice(start, end).trim();
  if (sentence.length > 5 && sentence.length < 320) return sentence;
  return text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + 80)).trim();
}

/**
 * Contextual numeric comparison. Replaces a prior "collect every money/
 * percent figure into a global set and flag anything not in the set"
 * approach, which produced both false positives (equivalent values in
 * different formats: "$0.96 million" vs "$960,000", "42%" vs "42.0%",
 * "$66.6" vs "$66.60" — same value, different text) and false negatives
 * (a figure that exists somewhere in the source, attached to the wrong
 * fact, would silently pass because the number itself was "in the set").
 *
 * For each figure in the output, this finds the source figure of the
 * same kind (money/percent) whose surrounding words overlap the output
 * figure's surrounding words the most, and compares ONLY against that
 * best match. It only flags when there is exactly one clearly-best,
 * non-ambiguous contextual match AND the normalized values genuinely
 * differ. If no confident match exists, it does not flag anything —
 * staying conservative and deferring to semantic evaluation rather than
 * manufacturing a finding, per the "deterministic checks must remain
 * conservative" requirement.
 */
function contextualNumericCheck(request: string, output: string): { findings: Finding[]; anyCompared: boolean } {
  const reqNums = extractNumbers(request);
  const outNums = extractNumbers(output);
  const findings: Finding[] = [];
  let anyCompared = false;

  for (const on of outNums) {
    const candidates = reqNums.filter(rn => rn.kind === on.kind);
    if (!candidates.length) continue;
    const onCtx = contextWords(output, on.start, on.end);
    let best: NumMatch | null = null;
    let bestScore = 0;
    let ambiguous = false;
    for (const c of candidates) {
      const score = overlapScore(onCtx, contextWords(request, c.start, c.end));
      if (score > bestScore) { best = c; bestScore = score; ambiguous = false; }
      else if (score === bestScore && score > 0) ambiguous = true;
    }
    if (!best || bestScore < 1 || ambiguous) continue;

    anyCompared = true;
    if (!valuesEqual(on.value, best.value)) {
      findings.push(mkFinding({
        type: 'numerical_mismatch', severity: 'critical', confidence: 0.92,
        start: on.start, end: on.end, matchedText: on.raw,
        reason: on.kind === 'money'
          ? 'This figure differs from the matching amount in your request.'
          : 'This percentage differs from the matching figure in your request.',
        evidence: sentenceAround(request, best.start),
        suggestion: `Change "${on.raw}" to match your request ("${best.raw}").`,
      }));
    }
  }
  return { findings, anyCompared };
}

export interface DeterministicResult { findings: Finding[]; passed: string[]; wordCount: number; }

export function runDeterministic(request: string, output: string, adv: AdditionalChecks): DeterministicResult {
  const findings: Finding[] = [];
  const passed: string[] = [];

  const ph = detectPlaceholders(output);
  if (ph.length) {
    for (const p of ph) {
      findings.push(mkFinding({
        type: 'format_violation', severity: 'critical', confidence: 1,
        start: p.start, end: p.end, matchedText: p.text,
        reason: 'This looks like unfinished template text that was never filled in.',
        suggestion: 'Replace with the real value before sending.',
      }));
    }
  } else passed.push('No placeholders left in the text');

  const wc = countWords(output);
  if (adv.maxWords) {
    if (wc > adv.maxWordsVal) {
      findings.push(mkFinding({
        type: 'format_violation', severity: 'warning', confidence: 1,
        reason: `Output is ${wc} words, ${wc - adv.maxWordsVal} over the ${adv.maxWordsVal}-word limit.`,
        requirement: `Maximum ${adv.maxWordsVal} words`, suggestion: 'Shorten the output to fit the limit.',
      }));
    } else passed.push(`Within the ${adv.maxWordsVal}-word limit (${wc})`);
  }
  if (adv.minWords) {
    if (wc < adv.minWordsVal) {
      findings.push(mkFinding({
        type: 'format_violation', severity: 'warning', confidence: 1,
        reason: `Output is ${wc} words, below the ${adv.minWordsVal}-word minimum.`,
        requirement: `Minimum ${adv.minWordsVal} words`, suggestion: 'Expand the output with more detail.',
      }));
    } else passed.push(`Meets the ${adv.minWordsVal}-word minimum (${wc})`);
  }

  if (adv.requiredTerms && adv.requiredTermsVal.trim()) {
    const terms = adv.requiredTermsVal.split(',').map(s => s.trim()).filter(Boolean);
    const missing = terms.filter(t => !findOccurrences(output, t).length);
    if (missing.length) {
      findings.push(mkFinding({
        type: 'missing_requirement', severity: 'warning', confidence: 1,
        reason: `Missing required term${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
        requirement: `Must include: ${terms.join(', ')}`,
        suggestion: `Add ${missing.map(m => `"${m}"`).join(', ')} somewhere appropriate.`,
      }));
    } else if (terms.length) passed.push('Required terms present');
  }
  if (adv.forbiddenTerms && adv.forbiddenTermsVal.trim()) {
    const terms = adv.forbiddenTermsVal.split(',').map(s => s.trim()).filter(Boolean);
    let any = false;
    for (const t of terms) {
      for (const o of findOccurrences(output, t)) {
        any = true;
        findings.push(mkFinding({
          type: 'requirement_violation', severity: 'critical', confidence: 1,
          start: o.start, end: o.end, matchedText: o.text,
          reason: `Forbidden term detected: "${t}".`, requirement: `Must not include: ${terms.join(', ')}`,
          suggestion: 'Remove or rephrase this.',
        }));
      }
    }
    if (!any && terms.length) passed.push('No forbidden terms found');
  }
  if (adv.bulletFormat) {
    const hasBullets = /(^|\n)\s*[-*•]\s+/.test(output);
    if (!hasBullets) findings.push(mkFinding({
      type: 'format_violation', severity: 'warning', confidence: 1,
      reason: 'The output does not appear to use bullet points.', requirement: 'Require bullet points',
      suggestion: 'Reformat key points as bullets.',
    })); else passed.push('Uses bullet points');
  }
  if (adv.numberedFormat) {
    const hasNumbered = /(^|\n)\s*\d+[.)]\s+/.test(output);
    if (!hasNumbered) findings.push(mkFinding({
      type: 'format_violation', severity: 'warning', confidence: 1,
      reason: 'The output does not appear to use a numbered list.', requirement: 'Require numbered list',
      suggestion: 'Reformat key points as a numbered list.',
    })); else passed.push('Uses a numbered list');
  }

  if (request && request.trim()) {
    const { findings: numFindings, anyCompared } = contextualNumericCheck(request, output);
    findings.push(...numFindings);
    if (anyCompared && numFindings.length === 0) passed.push('Numbers checked against your request are consistent');
  }

  return { findings, passed, wordCount: wc };
}

/** Counts bullet/numbered list items — used as a hint fed to the
 * evaluator/verifier for quantity requirements, since counting distinct
 * enumerated items is something code can do exactly, while judging
 * whether prose (non-listed) content contains "5 recommendations" still
 * requires the model. Not used as a silent override — see lib/pipeline.ts. */
export function countListItems(text: string): number {
  const bulletMatches = text.match(/(^|\n)\s*[-*•]\s+\S/g) || [];
  const numberedMatches = text.match(/(^|\n)\s*\d+[.)]\s+\S/g) || [];
  return Math.max(bulletMatches.length, numberedMatches.length);
}

export function dedupe(findings: Finding[]): Finding[] {
  const withPos = findings.filter(f => f.start != null).sort((a, b) => (a.start! - b.start!));
  const withoutPos = findings.filter(f => f.start == null);
  const kept: Finding[] = [];
  for (const f of withPos) {
    const overlap = kept.find(k => k.start != null && !(f.end! <= k.start! || f.start! >= k.end!));
    if (!overlap) { kept.push(f); continue; }
    const fScore = (f.source === 'deterministic' ? 1 : 0) + f.confidence;
    const kScore = (overlap.source === 'deterministic' ? 1 : 0) + overlap.confidence;
    if (fScore > kScore) kept[kept.indexOf(overlap)] = f;
  }
  return [...kept, ...withoutPos].sort((a, b) => {
    if (a.start == null && b.start == null) return 0;
    if (a.start == null) return 1;
    if (b.start == null) return -1;
    return a.start - b.start;
  });
}
