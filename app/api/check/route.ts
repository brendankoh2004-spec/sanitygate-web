import { NextRequest, NextResponse } from 'next/server';
import { Providers } from '@/lib/pipeline';
import { getProvider } from '@/lib/llm';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { sanitizeAdditional } from '@/lib/types';
import { processCheck } from '@/lib/checkService';
import { encodeEvent, StreamEvent } from '@/lib/stream';

export const runtime = 'nodejs';
// Vercel Hobby ceiling. The pipeline keeps its own soft budget (PIPELINE_BUDGET_MS, default 50s)
// below this. On a Pro plan raise BOTH this value and PIPELINE_BUDGET_MS.
export const maxDuration = 60;

const MAX_REQUEST = Number(process.env.MAX_SOURCE_CHARS || 12000);
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT_CHARS || 12000);

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'SanityGate has reached its daily limit for your usage. Please try again later.' },
      { status: 429 },
    );
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_request', message: 'Invalid request.' }, { status: 400 }); }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.slice(0, 100) : '';
  const request = typeof body?.request === 'string' ? body.request.slice(0, MAX_REQUEST) : '';
  const output = typeof body?.output === 'string' ? body.output.slice(0, MAX_OUTPUT) : '';
  const additional = sanitizeAdditional(body?.additional);
  if (!sessionId) return NextResponse.json({ error: 'bad_request', message: 'Missing session.' }, { status: 400 });
  if (!output.trim()) return NextResponse.json({ error: 'bad_request', message: 'Paste the AI output to check first.' }, { status: 400 });

  // No API key => providers stay null => the pipeline reports an INCOMPLETE review (never a clean one).
  let providers: Providers = { extraction: null, evaluator: null, verifier: null };
  try {
    providers = { extraction: getProvider('extraction'), evaluator: getProvider('evaluator'), verifier: getProvider('verifier') };
  } catch { /* handled by the pipeline as incomplete */ }

  const supabase = getSupabase();
  const persist = async (row: Record<string, unknown>): Promise<boolean> => {
    if (!supabase) return false;
    const { error } = await supabase.from('checks').insert(row);
    if (error) { console.error('[sanitygate:persist] insert failed:', error.message); return false; }
    return true;
  };

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => { try { controller.enqueue(enc.encode(encodeEvent(e))); } catch { /* client went away */ } };
      try { await processCheck({ sessionId, request, output, additional }, { providers, persist }, send); }
      finally { try { controller.close(); } catch { /* already closed */ } }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-RateLimit-Remaining': String(Math.max(0, rl.limit - rl.count)),
    },
  });
}
