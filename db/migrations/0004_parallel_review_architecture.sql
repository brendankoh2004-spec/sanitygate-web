-- Migration: bring an existing SanityGate database up to the
-- parallel-review architecture (Direct Match + Coverage Trace + Reverse Check
-- -> flat error pool -> one adjudicator). See db/schema.sql for the current shape.
-- Idempotent — safe to run once, safe to re-run, safe against a current database.
--
-- 1. `eval_runs` recorded one model per OLD stage (evaluator / verifier /
--    extraction), all NOT NULL. The evaluation harness now records the
--    reviewers' models and the adjudicator's model, so:
--      * the two new columns are added, and
--      * the old three stop being mandatory (otherwise every eval-run insert
--        would be rejected). Historical rows keep their values.
alter table eval_runs add column if not exists reviewer_model text;
alter table eval_runs add column if not exists adjudicator_model text;
alter table eval_runs alter column evaluator_model drop not null;
alter table eval_runs alter column verifier_model drop not null;
alter table eval_runs alter column extraction_model drop not null;

-- Backfill so historical runs remain comparable under the new column names.
-- Only fills rows that have not been given a new-style value yet.
update eval_runs
   set reviewer_model = coalesce(reviewer_model, evaluator_model),
       adjudicator_model = coalesce(adjudicator_model, verifier_model)
 where reviewer_model is null and adjudicator_model is null;

-- 2. Requirement extraction no longer exists, so its accuracy metric is gone.
--    (It was a derived number, not source data.)
alter table eval_runs drop column if exists requirement_extraction_accuracy;

-- 3. `checks.extracted_requirements` is intentionally NOT dropped: it holds the
--    requirement ledgers of historical checks. The application no longer writes
--    or reads it (new rows take the column default). Drop it yourself once you
--    no longer need those ledgers:
--      alter table checks drop column if exists extracted_requirements;
--    Old `checks.findings` JSON (origins 'evaluator' / 'verifier_scan' /
--    'evaluator+scan') is NOT rewritten: lib/records.ts maps it to 'legacy' on read.
