-- Migration: bring an existing SanityGate database up to the pilot
-- architecture in this pass (see db/schema.sql for the full current shape).
-- Idempotent — safe to run once, safe to re-run, safe against a database
-- that's already current.
--
-- 1. `checks.diagnostics` is a GENUINELY NEW column. The pipeline now
--    records per-stage outcomes (deterministic / extraction / evaluator /
--    verify / scan: ok, error code, attempts, timing, model) plus internal
--    counters (e.g. how many findings the independent safety scan
--    corroborated). This is for engineers debugging via Supabase directly —
--    app/api/history explicitly selects a fixed column list that does NOT
--    include it, so it can never reach the browser. There is nothing to
--    rename it from; add it if missing.
alter table checks add column if not exists diagnostics jsonb not null default '{}'::jsonb;

-- 2. `finding_feedback.suggestion_useful` was written by an even older
--    version of the feedback UI. The current app (app/api/feedback/route.ts)
--    never reads or writes it, and no query in the codebase selects it —
--    exactly the dead column this cleanup pass is meant to remove. Existing
--    values are not migrated anywhere else because nothing consumes them.
alter table finding_feedback drop column if exists suggestion_useful;

-- 3. Sanity check: confirm `checks` and `finding_feedback` now have exactly
--    the columns the application expects.
-- select column_name, data_type from information_schema.columns where table_name = 'checks' order by ordinal_position;
-- select column_name, data_type from information_schema.columns where table_name = 'finding_feedback' order by ordinal_position;
