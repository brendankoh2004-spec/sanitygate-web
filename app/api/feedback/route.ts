import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

/** What the user did with a suggestion. Legacy values ('correct' / 'false_positive') remain valid for old rows. */
const FINDING_DECISIONS = ['accepted', 'ignored', 'undone'];

export async function POST(req: NextRequest) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ ok: false }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }

  const { checkId, kind } = body || {};
  if (!checkId || typeof checkId !== 'string') return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  if (kind === 'review') {
    const { useful, comment, caughtReal } = body;
    const { error } = await supabase.from('feedback').insert({
      check_id: checkId,
      useful: typeof useful === 'boolean' ? useful : null,
      comment: typeof comment === 'string' ? comment.slice(0, 2000) : null,
      caught_real: typeof caughtReal === 'string' ? caughtReal.slice(0, 20) : null,
    });
    if (error) { console.error('[sanitygate:feedback] review insert failed:', error.message); return NextResponse.json({ ok: false }, { status: 500 }); }
    return NextResponse.json({ ok: true });
  }

  if (kind === 'finding') {
    const { findingId, decision } = body;
    if (!findingId || !FINDING_DECISIONS.includes(decision)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const { error } = await supabase.from('finding_feedback').insert({
      check_id: checkId, finding_id: String(findingId).slice(0, 40), verdict: decision,
    });
    if (error) { console.error('[sanitygate:feedback] finding insert failed:', error.message); return NextResponse.json({ ok: false }, { status: 500 }); }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'bad_request' }, { status: 400 });
}
