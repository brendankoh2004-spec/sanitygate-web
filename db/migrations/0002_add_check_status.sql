-- Adds the check_status column (Part 6 product guarantee: CLEAN /
-- FINDINGS / NEEDS_REVIEW / CHECK_INCOMPLETE, see lib/types.ts
-- CheckStatus) to an existing `checks` table. Idempotent — safe to run
-- once, safe to re-run.
--
-- Existing rows predate this column and have no recorded status; they
-- default to 'clean', which is not necessarily accurate for historical
-- rows that had semantic_error set. Backfill from semantic_error where
-- we can infer it, since that field DOES already exist on every prior
-- version of this table.
alter table checks add column if not exists check_status text not null default 'clean';

update checks
set check_status = 'check_incomplete'
where semantic_error is not null
  and check_status = 'clean';
