import { findSpan, splitSentences, sameLocation } from '../lib/evidence';
import { applyEdits, editsConflict, canAccept, buildSegments } from '../lib/edits';
import { TextEdit } from '../lib/types';
import { check, done } from './helpers';

// ---- findSpan: evidence validation ---------------------------------------
{
  const text = 'The plan launches on December 15, 2026.  It is “final”.\nRevenue was S$8.42 million.';
  let m = findSpan(text, 'December 15, 2026');
  check('findSpan: exact match returns real offsets', m.found && m.exact && text.slice(m.start!, m.end!) === 'December 15, 2026' && m.occurrences === 1);
  m = findSpan(text, 'launches   on\nDecember 15, 2026');
  check('findSpan: whitespace drift is forgiven and maps back to the real span', m.found && !m.exact && text.slice(m.start!, m.end!) === 'launches on December 15, 2026', JSON.stringify(m) + '|' + text.slice(m.start ?? 0, m.end ?? 0));
  m = findSpan(text, 'it is "final"');
  check('findSpan: case + curly-quote drift is forgiven', m.found && text.slice(m.start!, m.end!) === 'It is “final”', text.slice(m.start ?? 0, m.end ?? 0));
  check('findSpan: a paraphrase is NOT found', !findSpan(text, 'The plan begins on December 15, 2026').found);
  check('findSpan: a slightly different number is NOT found', !findSpan(text, 'S$8.43 million').found);
  check('findSpan: empty/whitespace needle is not found', !findSpan(text, '').found && !findSpan(text, '   ').found && !findSpan(text, null).found);
  check('findSpan: repeated passage is reported as ambiguous', findSpan('a b a b a', 'a b').occurrences === 2);
  m = findSpan('x  hello\n\nworld  y', 'hello world');
  check('findSpan: mapped span excludes surrounding whitespace', m.found && 'x  hello\n\nworld  y'.slice(m.start!, m.end!) === 'hello\n\nworld');
}

// ---- sentence splitting ---------------------------------------------------
{
  const t = 'Revenue was S$8.42 million. Margin rose 2.5 points! Is it?\nNew line here.';
  const s = splitSentences(t).map(x => t.slice(x.start, x.end));
  check('splitSentences: decimals do not split; ends/newlines do', s.length === 4 && s[0] === 'Revenue was S$8.42 million.' && s[1] === 'Margin rose 2.5 points!' && s[3] === 'New line here.', JSON.stringify(s));
  check('sameLocation: overlap >= 50% of shorter span', sameLocation({ start: 0, end: 10 }, { start: 5, end: 30 }) && !sameLocation({ start: 0, end: 10 }, { start: 9, end: 30 }));
}

// ---- edits: targeted, original-offset, order independent ------------------
const ORIGINAL = 'Revenue was S$3.54 million. Launch on December 15, 2026. Unlike RivalCorp, we grew.';
const e = (orig: string, rep: string, occ = 0): TextEdit => { const s = ORIGINAL.indexOf(orig); return { start: s, end: s + orig.length, original: orig, replacement: rep }; };
const e1 = e('S$3.54 million', 'S$8.42 million');
const e2 = e('December 15, 2026', 'November 30, 2026');
const e3 = e('Unlike RivalCorp, ', '');
{
  const all = applyEdits(ORIGINAL, [e1, e2, e3]);
  check('applyEdits: three edits accumulate, only targeted passages change', all === 'Revenue was S$8.42 million. Launch on November 30, 2026. we grew.', all);
  check('applyEdits: result independent of the ORDER edits were accepted', applyEdits(ORIGINAL, [e3, e1, e2]) === all && applyEdits(ORIGINAL, [e2, e3, e1]) === all);
  check('applyEdits: the original string is never mutated', ORIGINAL.startsWith('Revenue was S$3.54') && applyEdits(ORIGINAL, []) === ORIGINAL);
  const partial = applyEdits(ORIGINAL, [e2]);
  check('accepting one finding leaves the other findings\' ORIGINAL offsets valid', ORIGINAL.slice(e1.start, e1.end) === 'S$3.54 million' && ORIGINAL.slice(e3.start, e3.end) === 'Unlike RivalCorp, ' && partial.includes('S$3.54 million'));
  const seq = [e2, e1, e3].reduce<TextEdit[]>((acc, x) => { acc.push(x); return acc; }, []);
  check('incremental accept -> undo -> accept converges to the same text', applyEdits(ORIGINAL, seq.slice(0, 2)) === applyEdits(ORIGINAL, [e1, e2]) && applyEdits(ORIGINAL, [...seq.slice(0, 2), e3]) === all);
}

// ---- conflicts & insertions ----------------------------------------------
{
  const overlapA = e('December 15, 2026', 'X');
  const overlapB: TextEdit = { start: overlapA.start + 3, end: overlapA.end + 5, original: 'x', replacement: 'Y' };
  check('editsConflict: overlapping ranges conflict', editsConflict(overlapA, overlapB) && !editsConflict(e1, e2));
  check('canAccept: blocks an edit that overlaps an accepted one', !canAccept(overlapB, [overlapA]) && canAccept(e1, [overlapA]));
  const ins: TextEdit = { start: 27, end: 27, original: '', replacement: ' Added sentence.' };
  check('insertion: applied at anchor, no conflict with adjacent edits', applyEdits(ORIGINAL, [ins, e2]).includes('million. Added sentence. Launch on November'), applyEdits(ORIGINAL, [ins, e2]));
  check('insertion inside another range conflicts; at its boundary does not', editsConflict({ start: 5, end: 5, original: '', replacement: 'x' }, { start: 0, end: 10, original: '', replacement: '' }) && !editsConflict({ start: 10, end: 10, original: '', replacement: 'x' }, { start: 0, end: 10, original: '', replacement: '' }));
  const bad: TextEdit = { start: 5, end: 99999, original: '', replacement: 'zzz' };
  check('applyEdits: out-of-range edit is ignored, never throws', applyEdits('short', [bad]) === 'short');
  check('applyEdits: a conflicting later edit is skipped, not half-applied', applyEdits(ORIGINAL, [overlapA, overlapB]) === applyEdits(ORIGINAL, [overlapA]));
}

// ---- render segments -------------------------------------------------------
{
  const segs = buildSegments(ORIGINAL, [
    { id: 'a', start: e1.start, end: e1.end, state: 'accepted', replacement: 'S$8.42 million', severity: 'critical' },
    { id: 'b', start: e2.start, end: e2.end, state: 'pending', replacement: '', severity: 'warning' },
  ]);
  const text = segs.map(s => s.text).join('');
  check('segments: accepted shows replacement, pending shows original passage', text === 'Revenue was S$8.42 million. Launch on December 15, 2026. Unlike RivalCorp, we grew.', text);
  check('segments: kinds are text/accepted/pending as expected', segs.some(s => s.kind === 'accepted') && segs.some(s => s.kind === 'pending'));
  const ov = buildSegments('abcdefghij', [
    { id: 'x', start: 2, end: 6, state: 'pending', replacement: '', severity: 'warning' },
    { id: 'y', start: 4, end: 8, state: 'pending', replacement: '', severity: 'warning' },
  ]);
  check('segments: overlapping marks do not duplicate or drop text', ov.map(s => s.text).join('') === 'abcdefghij');
}

done();
