import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { fromDbRow } from '@/lib/records';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ checks: [], persistenceAvailable: false });

  // Explicit column list (never select('*')) so internal columns such as
  // `diagnostics` and `semantic_error` can never reach the browser.
  const { data, error } = await supabase
    .from('checks')
    .select('id, session_id, created_at, request, output, additional, extracted_requirements, findings, passed_checks, word_count, duration_ms, has_reference, check_status, semantic_error')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[sanitygate:history] query failed:', error.message);
    return NextResponse.json({ checks: [], persistenceAvailable: true, error: 'history_unavailable' }, { status: 500 });
  }
  return NextResponse.json({ checks: (data || []).map(fromDbRow), persistenceAvailable: true });
}
