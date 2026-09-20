import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ ok: false, message: 'Persistence not configured.' }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }

  const { checkId, kind } = body;
  if (!checkId || typeof checkId !== 'string') return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  if (kind === 'review') {
    const { useful, comment, caughtReal } = body;
    const { error } = await supabase.from('feedback').insert({
      check_id: checkId,
      useful: typeof useful === 'boolean' ? useful : null,
      comment: typeof comment === 'string' ? comment.slice(0, 2000) : null,
      caught_real: typeof caughtReal === 'string' ? caughtReal : null,
    });
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (kind === 'finding') {
    const { findingId, verdict, suggestionUseful } = body;
    if (!findingId || !['correct', 'false_positive'].includes(verdict)) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const { error } = await supabase.from('finding_feedback').insert({
      check_id: checkId, finding_id: String(findingId), verdict,
      suggestion_useful: typeof suggestionUseful === 'boolean' ? suggestionUseful : null,
    });
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'bad_request' }, { status: 400 });
}
