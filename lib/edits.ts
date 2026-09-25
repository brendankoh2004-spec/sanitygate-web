/**
 * Targeted-edit engine.
 *
 * Every edit is expressed in ORIGINAL-text offsets and those offsets never
 * change. The corrected text is always *derived* (original + accepted
 * edits), so accepting, undoing or ignoring one finding can never shift or
 * corrupt the location of any other finding.
 */
import { TextEdit } from './types';

/** Zero-width insertions only conflict with ranges that strictly contain the insertion point. */
export function editsConflict(a: TextEdit, b: TextEdit): boolean {
  const aIns = a.start === a.end, bIns = b.start === b.end;
  if (aIns && bIns) return false;
  if (aIns) return b.start < a.start && a.start < b.end;
  if (bIns) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export function canAccept(edit: TextEdit, accepted: TextEdit[]): boolean {
  return !accepted.some(a => editsConflict(a, edit));
}

/** Applies non-conflicting edits (relative to the original text). A conflicting later edit is skipped, never half-applied. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const ordered = edits
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.start >= 0 && e.end >= e.start && e.end <= text.length)
    .sort((x, y) => x.e.start - y.e.start || x.e.end - y.e.end || x.i - y.i);
  let out = '', cursor = 0;
  for (const { e } of ordered) {
    if (e.start < cursor) continue;               // overlaps an already-applied edit
    out += text.slice(cursor, e.start) + e.replacement;
    cursor = e.end;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------
// Rendering model for the output panel (pure, so it is unit-testable)
// ---------------------------------------------------------------------
export type MarkState = 'pending' | 'accepted';
export interface MarkInput { id: string; start: number; end: number; state: MarkState; replacement: string; severity: 'critical' | 'warning' }
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'pending'; id: string; text: string; severity: 'critical' | 'warning' }
  | { kind: 'accepted'; id: string; text: string };

/** Builds display segments over the original text. Pending marks highlight the original passage; accepted marks show the replacement. Overlapping marks: the earlier one wins. */
export function buildSegments(text: string, marks: MarkInput[]): Segment[] {
  const sorted = [...marks].filter(m => m.start >= 0 && m.end <= text.length && m.end >= m.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.start < cursor) continue;
    if (m.start > cursor) segs.push({ kind: 'text', text: text.slice(cursor, m.start) });
    if (m.state === 'accepted') segs.push({ kind: 'accepted', id: m.id, text: m.replacement });
    else if (m.end > m.start) segs.push({ kind: 'pending', id: m.id, text: text.slice(m.start, m.end), severity: m.severity });
    cursor = m.end;
  }
  if (cursor < text.length) segs.push({ kind: 'text', text: text.slice(cursor) });
  return segs;
}
