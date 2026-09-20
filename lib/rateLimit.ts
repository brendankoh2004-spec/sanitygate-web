import { getSupabase } from './supabase';

const DEFAULT_LIMIT = Number(process.env.RATE_LIMIT_CHECKS_PER_DAY || 25);

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Increments today's check count for this IP and reports whether the
 * request should be allowed. Uses a Postgres function (see db/schema.sql
 * -> increment_rate_limit) for an atomic upsert, so concurrent serverless
 * invocations on Vercel don't race each other the way an in-memory
 * counter would (an in-memory Map only limits a single warm instance,
 * which is not a reliable limit on serverless — hence the DB approach).
 *
 * If Supabase isn't configured (e.g. local dev without a DB), this
 * fails open (allowed: true) rather than blocking all local testing —
 * this is a known, documented limitation for that specific case.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const supabase = getSupabase();
  if (!supabase) return { allowed: true, count: 0, limit: DEFAULT_LIMIT };

  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc('increment_rate_limit', { p_ip: ip, p_day: day });
  if (error) {
    // Fail open on infrastructure errors so a DB hiccup doesn't take the
    // whole product down, but this is logged for visibility.
    console.error('rate limit check failed:', error.message);
    return { allowed: true, count: 0, limit: DEFAULT_LIMIT };
  }
  const count = typeof data === 'number' ? data : 0;
  return { allowed: count <= DEFAULT_LIMIT, count, limit: DEFAULT_LIMIT };
}

export function getClientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return headers.get('x-real-ip') || 'unknown';
}
