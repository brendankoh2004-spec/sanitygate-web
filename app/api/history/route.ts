import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// Mirrors the full `checks` table shape (db/schema.sql) since this route
// selects '*'. Explicit on purpose — see app/api/admin/stats/route.ts for
// why we don't rely on inferring row shapes through the query builder.
interface CheckRow {
  id: string;
  session_id: string;
  created_at: string;
  request: string;
  output: string;
  additional: unknown;
  extracted_requirements: unknown;
  findings: unknown;
  passed_checks: unknown;
  word_count: number;
  duration_ms: number;
  semantic_error: string | null;
  has_reference: boolean;
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ checks: [], persistenceAvailable: false });

  const { data, error } = await supabase
    .from('checks')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ checks: [], persistenceAvailable: true, error: error.message }, { status: 500 });

  const checks = ((data || []) as CheckRow[]).map((row: CheckRow) => ({
    id: row.id, sessionId: row.session_id, createdAt: row.created_at,
    request: row.request, output: row.output, additional: row.additional,
    extractedRequirements: row.extracted_requirements,
    findings: row.findings, passedChecks: row.passed_checks, wordCount: row.word_count,
    durationMs: row.duration_ms, semanticError: row.semantic_error, hasReference: row.has_reference,
  }));
  return NextResponse.json({ checks, persistenceAvailable: true });
}
