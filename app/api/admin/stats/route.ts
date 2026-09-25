import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface CheckStatsRow {
  id: string;
  session_id: string;
  created_at: string;
  findings: { category?: string; type?: string; origin?: string }[] | null;
  has_reference: boolean;
  check_status: string | null;
  word_count: number;
  duration_ms: number;
}
interface FeedbackRow { useful: boolean | null; caught_real: string | null }
interface FindingFeedbackRow { verdict: string }

function isAdmin(req: NextRequest): boolean {
  const key = req.headers.get('x-admin-key');
  return !!key && !!process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: 'no_database' }, { status: 200 });

  // Aggregation only — never request/output text.
  const { data: checks, error } = await supabase
    .from('checks')
    .select('id, session_id, created_at, findings, has_reference, check_status, word_count, duration_ms')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: feedback } = await supabase.from('feedback').select('useful, caught_real');
  const { data: findingFeedback } = await supabase.from('finding_feedback').select('verdict');

  const now = Date.now();
  const rows: CheckStatsRow[] = (checks || []) as CheckStatsRow[];
  const today = rows.filter(r => now - new Date(r.created_at).getTime() < 86400000);
  const week = rows.filter(r => now - new Date(r.created_at).getTime() < 7 * 86400000);

  const perSession: Record<string, number> = {};
  rows.forEach(r => { perSession[r.session_id] = (perSession[r.session_id] || 0) + 1; });
  const sessionCounts = Object.values(perSession);
  const totalSessions = sessionCounts.length;
  const returning = sessionCounts.filter(c => c >= 2).length;
  const power = sessionCounts.filter(c => c >= 5).length;

  const catFreq: Record<string, number> = {};
  const originFreq: Record<string, number> = {};
  let totalFindings = 0;
  rows.forEach(r => (r.findings || []).forEach(f => {
    const c = f.category || f.type || 'unknown';
    catFreq[c] = (catFreq[c] || 0) + 1;
    if (f.origin) originFreq[f.origin] = (originFreq[f.origin] || 0) + 1;
    totalFindings++;
  }));

  const fb = (feedback || []) as FeedbackRow[];
  const withUseful = fb.filter(f => f.useful != null);
  const withCaught = fb.filter(f => f.caught_real != null);
  const ff = (findingFeedback || []) as FindingFeedbackRow[];
  const accepted = ff.filter(f => f.verdict === 'accepted').length;
  const ignored = ff.filter(f => f.verdict === 'ignored').length;

  return NextResponse.json({
    users: { totalSessions, returning, power, returningPct: totalSessions ? Math.round((returning / totalSessions) * 100) : 0 },
    checks: { total: rows.length, today: today.length, week: week.length, avgPerSession: totalSessions ? +(rows.length / totalSessions).toFixed(2) : 0 },
    quality: {
      avgFindingsPerCheck: rows.length ? +(totalFindings / rows.length).toFixed(2) : 0,
      sourceUsedPct: pct(rows.filter(r => r.has_reference).length, rows.length) ?? 0,
      incompletePct: pct(rows.filter(r => r.check_status === 'check_incomplete').length, rows.length) ?? 0,
      usefulPct: pct(withUseful.filter(f => f.useful === true).length, withUseful.length),
      caughtRealPct: pct(withCaught.filter(f => f.caught_real === 'true').length, withCaught.length),
      suggestionsAcceptedPct: pct(accepted, accepted + ignored),
    },
    findingTypes: Object.entries(catFreq).sort((a, b) => b[1] - a[1]),
    findingOrigins: Object.entries(originFreq).sort((a, b) => b[1] - a[1]),
  });
}
