/**
 * Programmatic evidence validation. Nothing a model claims to quote is ever
 * displayed unless it was located in the REAL request/output text, and what
 * is displayed is always sliced from the real text, never the model's copy.
 */

export interface Span { start: number; end: number }

export interface SpanMatch {
  found: boolean;
  exact: boolean;          // true = verbatim substring; false = matched after whitespace/case/quote-style normalisation
  start: number | null;
  end: number | null;
  occurrences: number;     // >1 => ambiguous location (auto-edits must not be built on it)
}

const NOT_FOUND: SpanMatch = { found: false, exact: false, start: null, end: null, occurrences: 0 };

function normChar(ch: string): string {
  switch (ch) {
    case '\u2018': case '\u2019': case '\u201B': return "'";
    case '\u201C': case '\u201D': return '"';
    case '\u2013': case '\u2014': case '\u2212': return '-';
    case '\u2026': return '...';
    default: return ch.toLowerCase();
  }
}

/** Normalises whitespace runs, case and typographic quotes/dashes, keeping a map back to original indices. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) { norm += ' '; map.push(i); prevSpace = true; }
      continue;
    }
    prevSpace = false;
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); map.pop(); }
  return { norm, map };
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0, from = 0;
  while (true) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    n++; from = i + Math.max(1, needle.length);
    if (n > 50) return n;
  }
}

export function findSpan(haystack: string, needle: string | null | undefined): SpanMatch {
  if (!needle || !needle.trim()) return NOT_FOUND;

  const idx = haystack.indexOf(needle);
  if (idx >= 0) {
    return { found: true, exact: true, start: idx, end: idx + needle.length, occurrences: countOccurrences(haystack, needle) };
  }
  const trimmed = needle.trim();
  const tIdx = trimmed === needle ? -1 : haystack.indexOf(trimmed);
  if (tIdx >= 0) {
    return { found: true, exact: true, start: tIdx, end: tIdx + trimmed.length, occurrences: countOccurrences(haystack, trimmed) };
  }

  // Normalised fallback: forgives only whitespace / case / quote-style drift.
  // Deliberately NOT fuzzy: a merely "close" quote is exactly the soft
  // hallucination this module exists to catch.
  const h = normalizeWithMap(haystack);
  const n = normalizeWithMap(needle).norm;
  if (!n) return NOT_FOUND;
  const ni = h.norm.indexOf(n);
  if (ni < 0) return NOT_FOUND;
  const start = h.map[ni];
  const end = h.map[ni + n.length - 1] + 1;
  return { found: true, exact: false, start, end, occurrences: countOccurrences(h.norm, n) };
}

export function spanOverlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Two spans describe the same location if they overlap by >=50% of the shorter one. */
export function sameLocation(a: Span, b: Span): boolean {
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  if (shorter <= 0) return false;
  return spanOverlap(a, b) / shorter >= 0.5;
}

/** Sentence spans; a '.' followed by a non-space (e.g. the decimal point in "$8.42") does not end a sentence. */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { push(start, i); start = i + 1; continue; }
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i;
      while (j + 1 < text.length && '.!?"\u201D\')'.includes(text[j + 1])) j++;
      if (j + 1 >= text.length || /\s/.test(text[j + 1])) { push(start, j + 1); start = j + 1; i = j; }
    }
  }
  push(start, text.length);
  return out;
}
