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

interface NumMatch { type: 'money' | 'percent'; raw: string; norm: string; start: number; end: number; }

function extractMoneyAndPercent(text: string): NumMatch[] {
  const out: NumMatch[] = [];
  const moneyRe = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s?\/\s?(?:user\/mo(?:nth)?|mo|month|yr|year|wk|week))?/gi;
  const pctRe = /\d{1,3}(?:\.\d+)?\s?%/g;
  let m: RegExpExecArray | null;
  while ((m = moneyRe.exec(text))) out.push({ type: 'money', raw: m[0], norm: normMoney(m[0]), start: m.index, end: m.index + m[0].length });
  while ((m = pctRe.exec(text))) out.push({ type: 'percent', raw: m[0], norm: normPct(m[0]), start: m.index, end: m.index + m[0].length });
  return out.sort((a, b) => a.start - b.start);
}
function normMoney(s: string): string {
  const n = (s.match(/[\d,.]+/) || [''])[0].replace(/,/g, '');
  let per = '';
  if (/\/\s?user\/mo/i.test(s)) per = '/user/mo';
  else if (/\/\s?(mo|month)/i.test(s)) per = '/mo';
  else if (/\/\s?(yr|year)/i.test(s)) per = '/yr';
  return n + per;
}
function normPct(s: string): string { return (s.match(/[\d.]+/) || [''])[0] + '%'; }

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
    const sNums = extractMoneyAndPercent(request);
    const oNums = extractMoneyAndPercent(output);
    // Map norm -> the first verbatim raw string seen for it, so evidence
    // and suggestions shown to the user quote real source text (e.g.
    // "$24/user/month") rather than the internal normalized comparison
    // key (e.g. "24/user/mo"), which is easy to lose the "$" from.
    const sMoneyRaw = new Map<string, string>();
    sNums.filter(n => n.type === 'money').forEach(n => { if (!sMoneyRaw.has(n.norm)) sMoneyRaw.set(n.norm, n.raw.trim()); });
    const sPctRaw = new Map<string, string>();
    sNums.filter(n => n.type === 'percent').forEach(n => { if (!sPctRaw.has(n.norm)) sPctRaw.set(n.norm, n.raw.trim()); });

    let flagged = false;
    if (sMoneyRaw.size) {
      const rawList = [...sMoneyRaw.values()];
      for (const n of oNums.filter(n => n.type === 'money')) {
        if (!sMoneyRaw.has(n.norm)) {
          flagged = true;
          findings.push(mkFinding({
            type: 'numerical_mismatch', severity: 'critical', confidence: 0.96,
            start: n.start, end: n.end, matchedText: n.raw,
            reason: 'Your request lists different pricing than what appears in the output.',
            evidence: `Amount(s) in your request: ${rawList.join(', ')}`,
            suggestion: `Change "${n.raw}" to match your request (${rawList.join(' or ')}).`,
          }));
        }
      }
    }
    if (sPctRaw.size) {
      const rawList = [...sPctRaw.values()];
      for (const n of oNums.filter(n => n.type === 'percent')) {
        if (!sPctRaw.has(n.norm)) {
          flagged = true;
          findings.push(mkFinding({
            type: 'numerical_mismatch', severity: 'critical', confidence: 0.9,
            start: n.start, end: n.end, matchedText: n.raw,
            reason: 'Your request lists a different percentage than what appears in the output.',
            evidence: `Percentage(s) in your request: ${rawList.join(', ')}`,
            suggestion: `Change "${n.raw}" to match your request (${rawList.join(' or ')}).`,
          }));
        }
      }
    }
    if (!flagged && (sMoneyRaw.size || sPctRaw.size)) passed.push('Numbers match what you provided, where directly comparable');
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
