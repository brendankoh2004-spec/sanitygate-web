import { NextRequest, NextResponse } from 'next/server';
import { runPipeline, Providers } from '@/lib/pipeline';
import { getProvider } from '@/lib/llm';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { DEFAULT_ADDITIONAL, CheckRecord } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_REQUEST = Number(process.env.MAX_SOURCE_CHARS || 12000);
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT_CHARS || 12000);

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);

  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'SanityGate has temporarily reached its free AI capacity for your usage today. Please try again later.' },
      { status: 429 },
    );
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 100) : null;
  const request = typeof body.request === 'string' ? body.request.slice(0, MAX_REQUEST) : '';
  const output = typeof body.output === 'string' ? body.output.slice(0, MAX_OUTPUT) : '';
  const additional = { ...DEFAULT_ADDITIONAL, ...(body.additional && typeof body.additional === 'object' ? body.additional : {}) };

  if (!sessionId) return NextResponse.json({ error: 'bad_request', message: 'Missing sessionId.' }, { status: 400 });
  if (!output.trim()) return NextResponse.json({ error: 'bad_request', message: 'AI output is required.' }, { status: 400 });

  let providers: Providers = { extraction: null, evaluator: null, verifier: null };
  try {
    providers = { extraction: getProvider('extraction'), evaluator: getProvider('evaluator'), verifier: getProvider('verifier') };
  } catch (e) {
    // No API key configured — proceed deterministic-only rather than 500ing.
  }

  const result = await runPipeline(providers, request, output, additional);

  const rec: CheckRecord = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    request, output, additional,
    findings: result.findings,
    passedChecks: result.passedChecks,
    wordCount: result.wordCount,
    durationMs: result.durationMs,
    semanticError: result.semanticError,
    hasReference: result.hasReference,
    extractedRequirements: result.extractedRequirements,
    checkStatus: result.checkStatus,
  };

  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from('checks').insert({
      id: rec.id, session_id: rec.sessionId, created_at: rec.createdAt,
      request: rec.request, output: rec.output, additional: rec.additional,
      extracted_requirements: rec.extractedRequirements,
      findings: rec.findings, passed_checks: rec.passedChecks, word_count: rec.wordCount,
      duration_ms: rec.durationMs, semantic_error: rec.semanticError, has_reference: rec.hasReference,
      check_status: rec.checkStatus,
    });
    if (error) console.error('failed to persist check:', error.message);
  }

  return NextResponse.json(rec, {
    headers: { 'X-RateLimit-Remaining': String(Math.max(0, rl.limit - rl.count)) },
  });
}
