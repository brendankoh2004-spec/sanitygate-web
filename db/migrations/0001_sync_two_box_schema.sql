-- Migration: sync an EXISTING SanityGate database to the current
-- two-box application model.
--
-- Context: db/schema.sql uses `create table if not exists`, which is a
-- no-op against a table that already exists. When the product moved
-- from the three-box (source/output/rules) design to the two-box
-- (request/output) design, schema.sql and the application code were
-- updated together, but a database created from an earlier version of
-- schema.sql was never migrated — its `checks` table still has the old
-- column names. This is why production logs show:
--   "Could not find the 'additional' column of 'checks' in the schema cache"
--
-- This script is idempotent: safe to run once, safe to re-run, and safe
-- to run against a database that's already on the current schema (every
-- step is a no-op if there's nothing to do).
--
-- Run this FIRST, then re-run db/schema.sql in full (also idempotent) to
-- make sure every table/function/index that's supposed to exist does.

-- ---------------------------------------------------------------------
-- checks: source -> request, adv -> additional, has_source -> has_reference
-- These are straight renames — same concept, same data, new name, all
-- introduced together in the two-box redesign.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'source')
     and not exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'request') then
    alter table checks rename column source to request;
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'adv')
     and not exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'additional') then
    alter table checks rename column adv to additional;
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'has_source')
     and not exists (select 1 from information_schema.columns where table_name = 'checks' and column_name = 'has_reference') then
    alter table checks rename column has_source to has_reference;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- checks: extracted_requirements is a GENUINELY NEW column — the
-- requirement-extraction step (and its auditable structured output)
-- didn't exist before the two-box redesign, so there is nothing to
-- rename it from. Add it if it's missing.
-- ---------------------------------------------------------------------
alter table checks add column if not exists extracted_requirements jsonb not null default '[]'::jsonb;

-- Defensive: ensures a correct shape even if this database predates all
-- of the above (e.g. `checks` exists but is missing `additional`/`request`
-- for some other reason). No-ops if already present.
alter table checks add column if not exists request text not null default '';
alter table checks add column if not exists additional jsonb not null default '{}'::jsonb;
alter table checks add column if not exists has_reference boolean not null default false;

-- ---------------------------------------------------------------------
-- checks: the old `requirements` column held free-text strings the user
-- typed directly into a dedicated "add requirement" box in the
-- three-box UI. That UI concept was removed entirely in the two-box
-- redesign — everything the user wants checked now goes in the single
-- request box and is parsed by the extraction step into
-- `extracted_requirements` instead. There is no lossless mapping from
-- old free-text requirements to the new structured shape, and the
-- application never reads or writes this column anymore, so keeping it
-- around would be exactly the dead/redundant column this migration is
-- meant to avoid. Drop it.
-- ---------------------------------------------------------------------
alter table checks drop column if exists requirements;

-- ---------------------------------------------------------------------
-- eval_runs: the old shape recorded a single provider+model pair
-- (`provider`, `model`). The current shape tracks the evaluator,
-- verifier, and extraction models independently (spec: they must be
-- independently configurable) plus requirement_extraction_accuracy —
-- there is no 1:1 column mapping from old to new. This table is
-- regenerable telemetry only (each row is one golden-dataset run; you
-- can always produce a fresh one via the admin "Run checker evaluation"
-- button or `npm run eval`), so rather than force an artificial mapping
-- we recreate it cleanly when the old shape is detected.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'eval_runs' and column_name = 'provider')
     and not exists (select 1 from information_schema.columns where table_name = 'eval_runs' and column_name = 'evaluator_model') then
    drop table eval_runs;
  end if;
end $$;

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
alter table eval_runs enable row level security;

-- ---------------------------------------------------------------------
-- Sanity check: run this after the migration to confirm `checks` now
-- has exactly the columns the application expects.
-- ---------------------------------------------------------------------
-- select column_name, data_type from information_schema.columns
-- where table_name = 'checks' order by ordinal_position;
