import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the service-role key. This file must
 * NEVER be imported from a 'use client' component — it is only used from
 * app/api/**\/route.ts handlers, which run on the server.
 * Returns null if Supabase isn't configured, so the app can still run in
 * a degraded "no persistence" mode during local development.
 */
export function getSupabase(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
