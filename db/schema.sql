-- SanityGate pilot schema. Run this once in the Supabase SQL editor
-- (or via `supabase db push` if you use the CLI) before deploying.
--
-- IMPORTANT — upgrading an existing database: every statement below uses
-- `create table if not exists` / `create or replace function`, which are
-- no-ops against objects that already exist. If you already have a
-- SanityGate database from an earlier version of this schema, running
-- this file again will NOT rename or add columns for you. Run the
-- matching file in db/migrations/ first (see db/migrations/0001_sync_two_box_schema.sql),
-- then re-run this file to confirm everything's in place.
--
-- Design notes:
--  * No account system for the pilot — users are identified by an
--    anonymous session_id (random UUID generated client-side and stored
--    in localStorage). This satisfies "no account required for first use"
--    while still letting a returning visitor see their own history.
--  * Findings are stored as JSONB inside `checks` rather than a separate
--    table, since they're always read/written as a whole unit per check
--    and never queried individually across checks. Per-finding feedback
--    (accepted / ignored / undone) references the finding's client-generated
--    id as text.
--  * Raw source/output text IS stored in `checks` (needed to re-render
--    history). This is called out explicitly in the privacy notice.
--    `retention_days` on `app_config` documents the intended retention
--    policy; enforcing deletion is a scheduled job you add in Supabase
--    (Database -> Cron) once you're ready — not wired up by default in
--    this pilot to avoid deleting data you might want to inspect early on.

create extension if not exists "pgcrypto";

create table if not exists checks (
  id text primary key,
  session_id text not null,
  created_at timestamptz not null default now(),
  request text not null default '',          -- "what did you ask the AI to do?" box (prompt/instructions/reference, all together)
  output text not null,
  additional jsonb not null default '{}'::jsonb,          -- AdditionalChecks (cta/bullets/numbered/required-terms/forbidden-terms/word-count)
  extracted_requirements jsonb not null default '[]'::jsonb, -- structured output of the requirement-extraction step, kept for auditability
  findings jsonb not null default '[]'::jsonb,
  passed_checks jsonb not null default '[]'::jsonb,
  word_count int not null default 0,
  duration_ms int not null default 0,
  semantic_error text,
  has_reference boolean not null default false,
  check_status text not null default 'clean',  -- 'clean'|'findings'|'needs_review'|'check_incomplete' — see lib/types.ts CheckStatus. A failed/incomplete semantic check must never be indistinguishable from a genuinely clean one.
  diagnostics jsonb not null default '{}'::jsonb  -- internal only: per-stage outcomes (ok/code/attempts/ms/model), notes and counters. NEVER selected by app/api/history (see its explicit column list) — for engineers debugging via Supabase directly, not for the browser.
);
create index if not exists checks_session_idx on checks (session_id, created_at desc);
create index if not exists checks_created_idx on checks (created_at desc);

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  check_id text not null references checks(id) on delete cascade,
  useful boolean,
  comment text,
  caught_real text, -- 'true' | 'false' | 'unsure'
  created_at timestamptz not null default now()
);

create table if not exists finding_feedback (
  id uuid primary key default gen_random_uuid(),
  check_id text not null references checks(id) on delete cascade,
  finding_id text not null,
  verdict text not null, -- 'accepted' | 'ignored' | 'undone' (legacy rows may still say 'correct' | 'false_positive')
  created_at timestamptz not null default now()
);

create table if not exists rate_limits (
  ip text not null,
  day date not null,
  count int not null default 0,
  primary key (ip, day)
);

-- Atomic increment-and-read used by lib/rateLimit.ts
create or replace function increment_rate_limit(p_ip text, p_day date)
returns int
language plpgsql
as $$
declare
  new_count int;
begin
  insert into rate_limits (ip, day, count)
  values (p_ip, p_day, 1)
  on conflict (ip, day) do update set count = rate_limits.count + 1
  returning count into new_count;
  return new_count;
end;
$$;

-- One row per golden-dataset run, so we can detect regressions when the
-- evaluator prompt or validators change. See evaluation/run_eval.ts and
-- app/api/admin/eval/route.ts.
create table if not exists eval_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  evaluator_model text not null,
  verifier_model text not null,
  extraction_model text not null,
  total_cases int not null,
  true_positives int not null,
  false_positives int not null,
  false_negatives int not null,
  true_negatives int not null,
  precision numeric,
  recall numeric,
  false_positive_rate numeric,
  evidence_accuracy numeric,
  suggestion_grounding_accuracy numeric,
  requirement_extraction_accuracy numeric,
  details jsonb not null default '[]'::jsonb
);

create table if not exists app_config (
  key text primary key,
  value jsonb not null
);
insert into app_config (key, value) values ('retention_days', '90')
  on conflict (key) do nothing;

-- Row Level Security: API routes use the service-role key (bypasses RLS),
-- so the app works out of the box. RLS is still enabled + locked down so
-- that if NEXT_PUBLIC_SUPABASE_ANON_KEY is ever used client-side by
-- mistake, it cannot read or write these tables directly.
alter table checks enable row level security;
alter table feedback enable row level security;
alter table finding_feedback enable row level security;
alter table rate_limits enable row level security;
alter table eval_runs enable row level security;
-- No policies are created, which means: no access at all via the anon
-- key. All access goes through the server-side API routes.
