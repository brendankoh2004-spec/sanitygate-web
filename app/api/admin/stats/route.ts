import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// Shapes of the rows we select — kept minimal and explicit so every
// downstream .filter/.map/.forEach callback is properly typed instead of
// inferring through Supabase's untyped query builder.
interface CheckStatsRow {
  id: string;
  session_id: string;
  created_at: string;
  findings: { type: string }[];
  has_reference: boolean;
  semantic_error: string | null;
  word_count: number;
  duration_ms: number;
}
interface FeedbackRow {
  useful: boolean | null;
  caught_real: string | null;
}
interface FindingFeedbackRow {
  verdict: string;
  suggestion_useful: boolean | null;
}

function isAdmin(req: NextRequest): boolean {
  const key = req.headers.get('x-admin-key');
  return !!key && !!process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY;
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: 'no_database' }, { status: 200 });

  // Only the fields needed for aggregation — never request/output text.
  const { data: checks, error } = await supabase
    .from('checks')
    .select('id, session_id, created_at, findings, has_reference, semantic_error, word_count, duration_ms')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: feedback } = await supabase.from('feedback').select('useful, caught_real');
  const { data: findingFeedback } = await supabase.from('finding_feedback').select('verdict, suggestion_useful');

  const now = Date.now();
  const rows: CheckStatsRow[] = checks || [];
  const today = rows.filter(r => now - new Date(r.created_at).getTime() < 86400000);
  const week = rows.filter(r => now - new Date(r.created_at).getTime() < 7 * 86400000);

  const perSession: Record<string, number> = {};
  rows.forEach(r => { perSession[r.session_id] = (perSession[r.session_id] || 0) + 1; });
  const sessionCounts = Object.values(perSession);
  const totalSessions = sessionCounts.length;
  const returning = sessionCounts.filter(c => c >= 2).length;
  const power = sessionCounts.filter(c => c >= 5).length;
  const avgPerSession = totalSessions ? rows.length / totalSessions : 0;

  const typeFreq: Record<string, number> = {};
  let totalFindings = 0;
  rows.forEach(r => {
    (r.findings || []).forEach((f: { type: string }) => {
      typeFreq[f.type] = (typeFreq[f.type] || 0) + 1;
      totalFindings++;
    });
  });

  const sourceUsedPct = rows.length ? Math.round((rows.filter(r => r.has_reference).length / rows.length) * 100) : 0;
  const semanticFailPct = rows.length ? Math.round((rows.filter(r => r.semantic_error).length / rows.length) * 100) : 0;
  const avgFindingsPerCheck = rows.length ? +(totalFindings / rows.length).toFixed(2) : 0;

  const fb: FeedbackRow[] = feedback || [];
  const withUseful = fb.filter(f => f.useful != null);
  const usefulPct = withUseful.length ? Math.round((withUseful.filter(f => f.useful === true).length / withUseful.length) * 100) : null;
  const withCaught = fb.filter(f => f.caught_real != null);
  const caughtRealPct = withCaught.length ? Math.round((withCaught.filter(f => f.caught_real === 'true').length / withCaught.length) * 100) : null;

  const ff: FindingFeedbackRow[] = findingFeedback || [];
  const falsePositiveRate = ff.length ? Math.round((ff.filter(f => f.verdict === 'false_positive').length / ff.length) * 100) : null;
  const withSuggUseful = ff.filter(f => f.suggestion_useful != null);
  const suggestionUsefulPct = withSuggUseful.length ? Math.round((withSuggUseful.filter(f => f.suggestion_useful === true).length / withSuggUseful.length) * 100) : null;

  return NextResponse.json({
    users: { totalSessions, returning, power, returningPct: totalSessions ? Math.round((returning / totalSessions) * 100) : 0 },
    checks: { total: rows.length, today: today.length, week: week.length, avgPerSession: +avgPerSession.toFixed(2) },
    quality: { avgFindingsPerCheck, sourceUsedPct, semanticFailPct, usefulPct, caughtRealPct, falsePositiveRate, suggestionUsefulPct },
    findingTypes: Object.entries(typeFreq).sort((a, b) => b[1] - a[1]),
  });
}
