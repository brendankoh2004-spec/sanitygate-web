# SanityGate — public pilot

SanityGate checks AI-generated output against what you actually asked for
— instructions, reference facts, and constraints — highlights what doesn't
align, grounds every finding in the real request/output text, and suggests
a targeted correction you can accept or ignore. No account, no login, and
no secret is ever sent to the browser.

This is a real, runnable Next.js project. It is **not deployed by default**
— follow the steps below to put it online. Nothing here calls a live LLM
or a live database until you provide real credentials in step 2–3.

## Architecture

**Wide at detection, narrow at adjudication.** Four independent branches
look for possible errors in parallel; only possible errors move forward; one
adjudicator resolves them. Clean material is never re-reviewed.

```
REQUEST + OUTPUT
      |
      +------------+------------+------------+
      v            v            v            v
 DIRECT MATCH  COVERAGE     REVERSE      DETERMINISTIC     (one Promise.all; independent)
               TRACE        CHECK        CHECKS (code)
      |            |            |            |
      +--- PASS: discarded ---- FAIL: becomes a candidate ---+
                                                              v
                                ERROR POOL (one flat list: D1.. deterministic, E1.. reviewers)
                                                              |
                          no reviewer error? -> done, no model call
                                                              v
                                                ADJUDICATOR (one call)
                                                              v
                              FINAL FINDINGS -> grounded quotes -> validated fix
```

- **Deterministic checks** (`lib/validators/deterministic.ts`): word count,
  list format, required/forbidden terms, leftover placeholders — only things
  whose answer never depends on understanding language. This is a *sibling*
  branch of the reviewers, not a stage in front of them: it is CPU-only,
  started after the model calls are in flight, and a crash in it fails only
  its own branch. A failure is proven by code, so it is a final finding that
  needs no adjudication; it enters the pool as context (so the adjudicator
  can mark a reviewer's duplicate of it) and is never re-judged by a model. A
  pass is discarded.
- **Direct Match**: is the OUTPUT, as a whole, an appropriate response to
  what the user communicated? Catches contextual mismatches ("I'm going to
  Japan next week." → "How was your weekend?") without turning every
  sentence of the request into a requirement.
- **Coverage Trace**: is meaningful information, a question, a constraint or
  a prohibition in the REQUEST omitted, contradicted or mishandled? Word and
  list-item counts are measured by code and handed to it.
- **Reverse Check**: reads the OUTPUT first, states what task it is actually
  answering (`inferred_task`), then compares that with the REQUEST. Catches
  output that looks related but answers a different question, and claims the
  request doesn't support (including unsupported causal claims). A single
  prompt reduces but cannot fully remove anchoring on the request.
- **Error pool**: every reviewer error is appended as-is. There is no
  matching, clustering or dedup before adjudication; reviewers may agree,
  disagree or overlap.
- **Adjudicator**: resolves pooled reviewer candidates only (decisions are
  keyed by candidate id; anything else is ignored). For each: confirmed /
  rejected / uncertain, `duplicate_of`, final category and severity, its own
  quotes, reason, and the smallest safe fix. It is told it is not a reviewer,
  and it alone carries the category definitions.
- **Evidence and edits** (`lib/evidence.ts`, `lib/edits.ts`): every displayed
  quote is located in the real request/output; every fix is validated against
  the real output (exact, unique, touching the flagged passage).
- **No adjudicator on clean output**: the adjudicator is called only if at
  least one *reviewer* raised an error (an execution-path guard in
  `lib/review.ts`, not a prompt hint). Deterministic failures alone never
  trigger it: code already proved them.

Categories (single definition, `SEMANTIC_CATEGORIES` in `lib/types.ts`):
`instruction_violation`, `factual_contradiction`, `unsupported_addition`,
`omission`, `unsupported_causal_claim`.

Status is always one of `clean` / `findings` / `needs_review` /
`check_incomplete`. A failed or partial review is **never** shown as clean.
One reviewer failing keeps the other branches' candidates (a role with no
configured provider fails alone as `unavailable`); if the adjudicator
fails, candidates survive as `uncertain`/`unadjudicated` (no fabricated
certainty), exact-span duplicates are collapsed in code, and the check is
marked incomplete. A request with no text (only "must include a CTA") runs
Coverage Trace alone, plus the deterministic branch.

Latency is `max(deterministic, direct, coverage, reverse) + adjudicator`, and
the adjudicator only when a reviewer raised an error. Every branch records
model, prompt size, max tokens, timeout and latency in `checks.diagnostics`.

The LLM is only ever called from server-side routes. `lib/llm/provider.ts`
is a provider-agnostic interface; `lib/llm/openrouter.ts` is the only
implementation. Models: `OPENROUTER_MODEL`, optionally overridden per role
with `DIRECT_MODEL` / `COVERAGE_MODEL` / `REVERSE_MODEL` /
`ADJUDICATOR_MODEL`. Pointing the reviewers at different model families is
the cheapest way to decorrelate their blind spots; nothing requires it.

## 1. Install

```bash
npm install
```

## 2. Database (Supabase)

1. Create a free project at https://supabase.com.
2. Open the SQL editor and run the contents of `db/schema.sql` once.
   - **Already have a SanityGate database from an earlier version?**
     `db/schema.sql` uses `create table if not exists`, which does nothing to
     an existing table. Run every file in `db/migrations/` in order (`0001`
     … `0004_parallel_review_architecture.sql`; all idempotent), then re-run
     `db/schema.sql`. `0004` is required: it makes the retired
     `evaluator_model` / `verifier_model` / `extraction_model` columns of
     `eval_runs` nullable and adds `reviewer_model` / `adjudicator_model`;
     without it, every evaluation-run insert is rejected.
     Historical data is kept: `checks.extracted_requirements` is no longer
     written or read but is not dropped (the migration says how to drop it
     if you want to), and old findings are read back with origin `legacy`.
3. Under Project Settings → API, copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (not the anon key) → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is server-only and bypasses Row Level Security —
that's intentional (see `db/schema.sql`: RLS is enabled with no policies, so
a leaked anon key has zero table access).

`checks.diagnostics` is persisted for debugging but is never selected by
`app/api/history` or `app/api/admin/stats`, so it can never reach the browser.

## 3. LLM provider (OpenRouter)

1. Create an account at https://openrouter.ai and generate a key at
   https://openrouter.ai/keys → `OPENROUTER_API_KEY`.
2. Pick a model with a decent context window and reliable
   instruction-following → `OPENROUTER_MODEL` (see
   https://openrouter.ai/models?max_price=0 for free ones).
3. Optional: `DIRECT_MODEL`, `COVERAGE_MODEL`, `REVERSE_MODEL`,
   `ADJUDICATOR_MODEL` to use a different model per role (each defaults to
   `OPENROUTER_MODEL`).
4. Set `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` to your deployed URL.

## 4. Admin key

```bash
openssl rand -hex 32
```

Set it as `ADMIN_API_KEY`; paste it into `/admin` to view analytics and run
the checker evaluation.

## 5. Local development

```bash
cp .env.example .env.local
npm run dev
```

With no LLM key configured, deterministic checks still run and any check that
needs the semantic review reports itself as incomplete rather than clean.

## 6. Run the tests

```bash
npm run test:unit       # no network/API key needed
npm run eval            # needs OPENROUTER_API_KEY — live calls, golden cases
npm run eval:q3-live    # needs OPENROUTER_API_KEY — one long realistic document
```

`npm run test:unit` runs every `test/*.test.ts` as a separate process against
scripted providers:

- `review.test.ts` — the architecture: four parallel branches (deterministic
  included, never a gate), PASS discarded, flat pool, unmatched candidates,
  `duplicate_of` consolidation, the adjudicator unable to invent findings,
  rejection, branch/adjudicator failure, grounded evidence,
  `unsupported_causal_claim`, omission anchors, CTA-only runs, deterministic
  failures in the pool, prompt design (no category definitions in reviewers),
  stage diagnostics.
- `architecture.test.ts` — guard: fails if the retired
  extraction/ledger/evaluator/verify/scan vocabulary reappears in production
  code, or the wiring (one `Promise.all` containing the deterministic branch,
  a single adjudicator, the empty-candidate early return, one category
  definition) changes.
- `resilience.test.ts` — every failure degrades to an honest incomplete,
  one failing reviewer never erases the others, nothing is called once the
  budget is gone.
- `checkService.test.ts` — streamed stages (`reviewing` / `confirming` /
  `finalising`; `confirming` only when there is something to adjudicate),
  persistence failures, crash handling.
- `persistence.test.ts` — the schema has every column the app writes,
  migrations are idempotent, `0004` does what the code needs, legacy rows
  read back correctly.
- `q3_long_case.test.ts` — a long multi-metric report with 7 seeded errors;
  the same figure used correctly for one metric and wrongly for another is
  flagged only where wrong; a correct, paraphrased version costs no
  adjudicator call.
- `deterministic.test.ts`, `evidence_edits.test.ts`, `llm_provider.test.ts`.

**`npm run eval`** runs `evaluation/golden_cases.json` against your live
provider and prints precision, recall, false-positive rate, evidence accuracy
and suggestion-grounding accuracy, writing a result to `evaluation/results/`.
(The retired `expectedExtractionTypes` field has been removed from the cases.) To lock in
a baseline:

```bash
cp evaluation/results/run-<timestamp>.json evaluation/results/baseline.json
```

It exits 1 on a regression; re-run it whenever you change a prompt in
`lib/prompts.ts`.

### Diagnosing an incomplete review in production

Check the function logs for `[sanitygate:<stage>]` where stage is `direct`,
`coverage`, `reverse`, `deterministic` or `adjudicator`, which tells you which
branch failed and why (timeout, rate limit, upstream error, unusable JSON,
salvaged partial, no provider configured).
Logs never include prompt text, request/output content or keys. Per-stage
model, prompt size, max tokens, timeout, latency and outcome are persisted in
`checks.diagnostics`.

## 7. Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Add every variable from `.env.example` in the Vercel project settings before
the first production deploy, then `vercel --prod`.

## 8. Verify it's really live

1. Visit the deployed URL in an incognito window.
2. Run the landing page's "See an example" check and watch the progress
   stages (Reviewing / Confirming / Finalising).
3. Confirm the result includes findings — that proves a real LLM call.
4. Open `/admin`, paste `ADMIN_API_KEY`, click **Run checker evaluation**.

## What's stored, and what isn't

- `checks`: request text, output text and findings — needed to show history.
  Aggregate analytics never select `request`/`output`.
- No account system. A random UUID in `localStorage` links a returning
  visitor to their own history; it is not tied to any identity.
- Whatever your OpenRouter model/provider does with submitted prompts is
  governed by **their** terms — see https://openrouter.ai/privacy before
  pasting confidential material, and say so in your pilot's privacy copy.
- `app_config.retention_days` documents an intended retention window; no
  deletion job ships by default — add a Supabase cron job first.

## Known limitations

- Rate limiting is per-IP via a Postgres counter; it fails open if Supabase
  is unreachable. Free OpenRouter models are rate-limited independently; a
  `429` surfaces as "SanityGate has reached its capacity", never as clean.
- Small/free models are weaker at strict JSON and nuanced judgment.
  `lib/llm/openrouter.ts` salvages truncated responses and the pipeline
  retries once, but a non-compliant or slow model can still produce an
  honest `check_incomplete`.
- **Time budget**: `maxDuration = 60` (Vercel Hobby). `PIPELINE_BUDGET_MS`
  (default 50000) keeps the soft budget under it; the reviewers share 60% of
  it as one absolute deadline and the adjudicator keeps the rest. Raise both
  together on a Pro plan.
- The adjudicator receives the full REQUEST and OUTPUT as grounding context
  (omissions and insertion anchors need the whole output), so its prompt
  grows with document size. There is a hard cap of 10 issues per reviewer.
- If the adjudicator fails, unresolved candidates are shown as uncertain;
  only identical exact spans are collapsed, so two reviewers flagging
  overlapping-but-different spans of one problem can both appear.
- History is per-browser. Per-finding accept/ignore decisions are
  client-side only and are not restored from history.
