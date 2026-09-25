/**
 * Deterministic layer — DELIBERATELY NARROW.
 *
 * Only checks whose answer never depends on understanding language:
 *   - word-count limits (whitespace-delimited words)
 *   - required / forbidden terms (whole-word / whole-phrase, case-insensitive)
 *   - bullet / numbered-list presence
 *   - leftover template placeholders
 *
 * Numbers, percentages, money, dates, contradictions, causal claims, "is this
 * a valid paraphrase" — all of that is owned by the semantic layer
 * (lib/semantic.ts). Do not add such checks here.
 */
import { Finding, AdditionalChecks } from '../types';

export function mkFinding(f: Partial<Finding> & Pick<Finding, 'reason'>): Finding {
  return {
    id: 'tmp', category: 'structural', severity: 'warning', strength: 'confirmed',
    origin: 'deterministic', verification: 'not_applicable',
    passage: null, requirementQuote: null, requirement: null, suggestion: null, edit: null,
    ...f,
  };
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[\s*(insert[^\]]*|todo|tbd|placeholder|company\s*name|customer\s*name|client\s*name|your\s*name|full\s*name|date|link|url|phone|email)\s*\]/gi,
  /\{\{\s*[\w.\- ]{1,40}\s*\}\}/g,
  /<\s*(insert[^>]*|company\s*name|customer\s*name|client\s*name|your\s*name|full\s*name)\s*>/gi,
  /\bXXX+\b/g,
];

interface Occ { start: number; end: number; text: string }

function detectPlaceholders(text: string): Occ[] {
  const out: Occ[] = [];
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

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Whole-word/phrase matching: "cat" does not match "category". Plurals/inflections are NOT matched (documented). */
export function findTerm(text: string, term: string): Occ[] {
  const out: Occ[] = [];
  const t = term.trim();
  if (!t) return out;
  const L = '(?<![\\p{L}\\p{N}_])', R = '(?![\\p{L}\\p{N}_])';
  const startsWord = /^[\p{L}\p{N}_]/u.test(t), endsWord = /[\p{L}\p{N}_]$/u.test(t);
  const re = new RegExp((startsWord ? L : '') + escapeRe(t).replace(/\s+/g, '\\s+') + (endsWord ? R : ''), 'giu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

function parseTerms(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

export interface DeterministicResult { findings: Finding[]; passed: string[]; wordCount: number }

export function runDeterministic(output: string, adv: AdditionalChecks): DeterministicResult {
  const findings: Finding[] = [];
  const passed: string[] = [];

  const ph = detectPlaceholders(output);
  if (ph.length) {
    for (const p of ph) {
      findings.push(mkFinding({
        severity: 'critical',
        passage: { start: p.start, end: p.end, text: p.text },
        reason: 'This looks like unfinished template text that was never filled in.',
        suggestion: 'Replace it with the real value before using the text.',
      }));
    }
  } else passed.push('No placeholders left in the text');

  const wc = countWords(output);
  if (adv.maxWords) {
    if (wc > adv.maxWordsVal) {
      findings.push(mkFinding({
        reason: `The output is ${wc} words, ${wc - adv.maxWordsVal} over the ${adv.maxWordsVal}-word limit.`,
        requirement: `Maximum ${adv.maxWordsVal} words`,
        suggestion: `Shorten the text by about ${wc - adv.maxWordsVal} words.`,
      }));
    } else passed.push(`Within the ${adv.maxWordsVal}-word limit (${wc})`);
  }
  if (adv.minWords) {
    if (wc < adv.minWordsVal) {
      findings.push(mkFinding({
        reason: `The output is ${wc} words, ${adv.minWordsVal - wc} under the ${adv.minWordsVal}-word minimum.`,
        requirement: `Minimum ${adv.minWordsVal} words`,
        suggestion: `Add about ${adv.minWordsVal - wc} more words of relevant detail.`,
      }));
    } else passed.push(`Meets the ${adv.minWordsVal}-word minimum (${wc})`);
  }

  if (adv.requiredTerms) {
    const terms = parseTerms(adv.requiredTermsVal);
    if (terms.length) {
      const missing = terms.filter(t => findTerm(output, t).length === 0);
      if (missing.length) {
        findings.push(mkFinding({
          reason: `Missing required term${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
          requirement: `Must include: ${terms.join(', ')}`,
          suggestion: `Work ${missing.map(m => `"${m}"`).join(', ')} into the text.`,
        }));
      } else passed.push('Required terms present');
    }
  }

  if (adv.forbiddenTerms) {
    const terms = parseTerms(adv.forbiddenTermsVal);
    if (terms.length) {
      let any = false;
      for (const t of terms) {
        for (const o of findTerm(output, t)) {
          any = true;
          findings.push(mkFinding({
            severity: 'critical',
            passage: { start: o.start, end: o.end, text: o.text },
            reason: `The output contains "${t}", which you said it must not.`,
            requirement: `Must not include: ${terms.join(', ')}`,
            suggestion: 'Remove this word.',
            edit: { start: o.start, end: o.end, original: o.text, replacement: '' },
          }));
        }
      }
      if (!any) passed.push('No forbidden terms found');
    }
  }

  if (adv.bulletFormat) {
    if (!/(^|\n)\s*[-*\u2022]\s+/.test(output)) {
      findings.push(mkFinding({ reason: 'The output does not use bullet points.', requirement: 'Use bullet points', suggestion: 'Reformat the key points as bullets.' }));
    } else passed.push('Uses bullet points');
  }
  if (adv.numberedFormat) {
    if (!/(^|\n)\s*\d+[.)]\s+/.test(output)) {
      findings.push(mkFinding({ reason: 'The output does not use a numbered list.', requirement: 'Use a numbered list', suggestion: 'Reformat the key points as a numbered list.' }));
    } else passed.push('Uses a numbered list');
  }

  return { findings, passed, wordCount: wc };
}

/** Programmatic list-item count, handed to the semantic evaluator as a measured fact. */
export function countListItems(text: string): number {
  const bullets = text.match(/(^|\n)\s*[-*\u2022]\s+\S/g) || [];
  const numbered = text.match(/(^|\n)\s*\d+[.)]\s+\S/g) || [];
  return Math.max(bullets.length, numbered.length);
}
