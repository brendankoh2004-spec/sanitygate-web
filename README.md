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

SanityGate deliberately splits the review into layers with narrow,
non-overlapping jobs:

```
Browser (no secrets)
  -> POST /api/check  (streams NDJSON progress events, then a final result)
       -> deterministic checks   (lib/validators/deterministic.ts)
            word count, required/forbidden terms, list format, leftover
            placeholders — ONLY things whose answer never depends on
            understanding language. No numbers, dates, money, or meaning.
       -> semantic review        (lib/semantic.ts, lib/prompts.ts)
            1. extraction  -> splits the request into a validated
               requirement ledger (every quote checked against the real
               request text; anything the model skips is added back
               programmatically so nothing is silently ungraded)
            2. evaluator   -> judges every ledger item individually
               (instruction followed? fact preserved? same subject as
               what the request describes, or a different metric/period
               entirely?), plus a separate pass for unsupported/causal
               claims the request doesn't back up
            3. verifier    -> TWO independent jobs, run in parallel:
                 VERIFY: re-checks each evaluator claim from scratch,
                   without seeing the evaluator's reasoning, and must
                   supply its OWN grounded quotes to confirm anything
                 SCAN:   an independent read of the raw request/output
                   with no requirement ledger and no candidate list —
                   a safety net for what the evaluator missed
       -> evidence validation    (lib/evidence.ts)
            every quote a model claims is located in the REAL request/
            output text before it can be shown; nothing sliced from a
            model's own copy of a passage is ever displayed
       -> merge + status         (lib/pipeline.ts)
            deterministic findings win on a shared passage; duplicate
            semantic findings about the same issue collapse into one;
            status is always one of clean / findings / needs_review /
            check_incomplete — a failed or partial review is NEVER
            represented as "clean"
       -> persistence            (lib/records.ts, lib/supabase.ts)
  <- NDJSON stream: stage events (Analysing/Reviewing/Verifying/Finalising),
     then one result event with the findings, or one error event
```

The LLM is only ever called from `app/api/*/route.ts`, which run server-side.
`OPENROUTER_API_KEY` never ships to the browser.

`lib/llm/provider.ts` defines a provider-agnostic `LLMProvider` interface.
`lib/llm/openrouter.ts` is the only implementation today. To add Gemini,
Anthropic, or OpenAI later, implement `LLMProvider` in a new file under
`lib/llm/` and add one case to `lib/llm/index.ts` — nothing else changes.
Model selection is intentionally minimal and opaque: `OPENROUTER_MODEL` (or
per-stage `EVALUATOR_MODEL` / `VERIFIER_MODEL` / `EXTRACTION_MODEL`) is
passed straight through to the provider. Nothing in the pipeline assumes a
specific model behaves perfectly — every response is validated, retried
once where that's sensible, and any residual failure becomes an honest
`check_incomplete` result rather than a crash or a false "clean".

## 1. Install

```bash
npm install
```

## 2. Database (Supabase)

1. Create a free project at https://supabase.com.
2. Open the SQL editor and run the contents of `db/schema.sql` once.
   - **Already have a SanityGate database from an earlier version of this
     project?** `db/schema.sql` uses `create table if not exists`, which
     does nothing to a table that already exists — it will NOT add or
     rename columns for you. Run every file in `db/migrations/` in order
     (`0001_sync_two_box_schema.sql`, `0002_add_check_status.sql`,
     `0003_diagnostics_and_cleanup.sql` — all idempotent, safe to run
     once or re-run), then re-run `db/schema.sql`.
3. Under Project Settings → API, copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (not the anon key) → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is server-only and bypasses Row Level Security —
that's intentional (see `db/schema.sql` for why RLS is enabled with no
policies: the anon key, if it ever leaked, would have zero table access).

`checks.diagnostics` (per-stage outcomes, model ids, internal counters) is
persisted for debugging but is never selected by `app/api/history` or
`app/api/admin/stats`, so it can never reach the browser.

## 3. LLM provider (OpenRouter)

1. Create a free account at https://openrouter.ai and generate an API key
   under https://openrouter.ai/keys → `OPENROUTER_API_KEY`.
2. Check https://openrouter.ai/models?max_price=0 for the current list of
   free models and pick one with a decent context window and reliable
   instruction-following. Set it as `OPENROUTER_MODEL`. This list changes
   over time — the provider abstraction makes swapping trivial.
3. Optional: set `EVALUATOR_MODEL` / `VERIFIER_MODEL` differently from each
   other. Since correlated mistakes are exactly what the verifier exists to
   catch, pointing it at a different model family is the cheapest lever
   for reducing correlated errors — but nothing requires it; all three
   stages default to `OPENROUTER_MODEL`.
4. Set `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` to your real deployed
   URL once you have one (some free models require this for attribution).

## 4. Admin key

Generate a random secret for the admin dashboard:

```bash
openssl rand -hex 32
```

Set it as `ADMIN_API_KEY`. This is the value you'll paste into `/admin`
to view pilot analytics and run the checker evaluation.

## 5. Local development

```bash
cp .env.example .env.local
# fill in the values from steps 2-4
npm run dev
```

Visit http://localhost:3000. The check screen still runs deterministic
checks with no LLM key configured — it reports the review as incomplete
rather than faking a clean result (see `lib/pipeline.ts`).

## 6. Run the tests

Two separate test layers, deliberately kept separate:

```bash
npm run test:unit       # no network/API key needed — runs in seconds
npm run eval             # requires a real OPENROUTER_API_KEY — live LLM calls, ~60 golden cases
npm run eval:q3-live     # requires a real OPENROUTER_API_KEY — manual spot-check on one long realistic document
```

**`npm run test:unit`** (`test/`) runs every `*.test.ts` file in `test/` as
a separate process (one file's failure doesn't stop the rest) against
mocked/scripted providers — no network, no API key, safe for CI on every
commit:

- `deterministic.test.ts` — word count, required/forbidden terms, format,
  placeholders, and a static guard that no numeric/date/context-matching
  code has crept back into the deterministic layer.
- `evidence_edits.test.ts` — quote-location/evidence validation and the
  targeted-edit engine (accept/undo in any order converges to the same
  text; edits never corrupt each other's offsets).
- `llm_provider.test.ts` — the OpenRouter provider against a mocked
  `fetch`: empty/malformed/truncated responses, timeouts on slow headers
  *and* a stalled body, 429/5xx, an HTTP-200 body carrying a provider
  error, and the JSON-salvage logic.
- `semantic.test.ts` — the ledger, the evaluator's local gating (same-
  subject / not-a-paraphrase), and the verifier's two jobs: a real issue
  confirmed, a false positive rejected and dropped, a verifier mistake
  that the independent scan still corroborates (shown as uncertain, not
  silently resolved either way), an evaluator miss the scan alone catches,
  an evaluator outage the scan still protects against, and a verifier
  outage that never lets a finding be marked "confirmed" regardless.
- `resilience.test.ts` — every failure mode in `runStage` (empty/malformed/
  truncated/timeout/rate-limit/upstream-error, each with the correct
  retry-or-not behavior), the platform timeout boundary (a stage is
  skipped, never attempted, once too little budget remains), and
  full-pipeline degradation (no provider configured, an unexpected
  exception, extraction failing while the rest of the review still runs).
- `checkService.test.ts` — the streamed NDJSON events end-to-end: the four
  product-facing stages appear in order, a persistence failure never hides
  the result, and an unexpected crash produces exactly one error event and
  no fabricated result.
- `persistence.test.ts` — `db/schema.sql` actually has every column the
  app writes (parsed from the file itself, so this fails loudly if they
  ever drift apart again), every migration looks idempotent, and old rows
  from the previous pipeline are read correctly (legacy finding shapes
  remapped, `check_status` inferred from `semantic_error` when absent).
- `q3_long_case.test.ts` — a realistic ~200-word multi-metric Q3 report
  (`evaluation/fixtures/q3.ts`) with 7 deliberately seeded errors spanning
  every finding category. The scripted evaluator/verifier decide every
  verdict dynamically from the real output text (not hardcoded per run),
  so this proves the pipeline — not the mock — understands which number
  belongs to which statement: the same figure (`S$3.54 million`) is used
  correctly for one metric and incorrectly for another in the same
  document, and only the wrong usage is flagged.

**`npm run eval`** (`evaluation/`) runs all cases in
`evaluation/golden_cases.json` against your live provider and prints
precision, recall, false-positive rate, evidence accuracy, suggestion-
grounding accuracy, and requirement-extraction accuracy. It writes a
timestamped result to `evaluation/results/`. To lock in a baseline for
future regression detection:

```bash
cp evaluation/results/run-<timestamp>.json evaluation/results/baseline.json
```

Re-run `npm run eval` whenever you change a prompt in `lib/prompts.ts`; it
exits with code 1 on a regression (wire this into CI).

**`npm run eval:q3-live`** runs the same Q3 fixture used in
`q3_long_case.test.ts` against your real configured model and prints every
finding it produces, for a quick human sanity check that the prompts work
in practice and not just against the scripted test double.

### Diagnosing an incomplete review in production

If the app ever shows "The review could not be fully completed," check the
Vercel function logs for a line starting `[sanitygate:<stage>]` — `stage`
is one of `extraction`, `evaluator[i/n]`, `verify`, or `scan`, telling you
exactly which call failed and why (timeout, rate limit, upstream HTTP
error, or a JSON parse failure, including whether a *partial* result was
salvaged before giving up). These logs never include prompt text, request/
output content, or API keys — only the failing stage, model name, and
error/timing diagnostics. The same diagnostics are also persisted per-check
in `checks.diagnostics` (never exposed to the browser) if you need to look
at a specific past check.

## 7. Deploy to Vercel

```bash
npm i -g vercel   # or use the Vercel web UI
vercel
```

In the Vercel project settings, add every variable from `.env.example`
(with real values) under **Environment Variables** — do this before your
first production deploy. Then:

```bash
vercel --prod
```

Your public URL (e.g. `https://sanitygate.vercel.app`) is what you send to
pilot users. No login, no Claude account, no API key of their own required.

## 8. Verify it's really live (do this before sending the link to anyone)

1. Visit the deployed URL in an incognito window.
2. Run the landing page's "See an example" check and watch the four
   progress stages (Analysing / Reviewing / Verifying / Finalising).
3. Confirm the result includes findings — that confirms a real LLM call
   happened, not just deterministic checks.
4. Open `/admin`, paste your `ADMIN_API_KEY`, click **Run checker
   evaluation**, and confirm real precision/recall numbers come back.

## What's stored, and what isn't

- `checks`: request text, output text, requirements, and findings — needed
  to show history. Raw text is **not** included in any aggregate analytics
  query (`app/api/admin/stats/route.ts` only ever selects `findings`,
  `has_reference`, `check_status`, timestamps — never `request`/`output`).
- No account system. A random UUID is generated client-side and stored in
  `localStorage` so a returning visitor sees their own history; it is not
  tied to an email or any identity.
- Whatever your configured OpenRouter model/provider does with submitted
  prompts is governed by **their** terms, not this project's — check
  https://openrouter.ai/privacy and your chosen model's provider page
  before pasting confidential material, and say so on your own pilot's
  landing/privacy copy.
- `app_config.retention_days` documents an intended retention window; no
  scheduled deletion job ships by default (see comment in `db/schema.sql`)
  — add a Supabase cron job before treating this as a real retention
  policy.

## Known limitations

- Rate limiting is per-IP via a Postgres counter (`db/schema.sql` →
  `increment_rate_limit`), which is correct across Vercel's serverless
  instances. It fails open if Supabase is unreachable.
- Free OpenRouter models are rate-limited by OpenRouter itself, independent
  of this app's own per-IP limit. A `429` surfaces as "SanityGate has
  reached its capacity for now" — never as a fake clean result.
- Small/free models are less reliable at strict JSON output and nuanced
  judgment than a frontier model. `lib/llm/openrouter.ts` salvages a
  partial result when a response is truncated mid-object, and retries
  once on an unusable/incomplete response — but a sufficiently
  non-compliant or slow model can still exhaust its retry and surface an
  honest `check_incomplete` result.
- **Vercel function time budget**: `app/api/check/route.ts` sets
  `maxDuration = 60` (the ceiling on Vercel's free/hobby tier).
  `PIPELINE_BUDGET_MS` (default 50000) keeps the pipeline's own soft
  budget a few seconds under that, so a stage that can't fit in the
  remaining time is skipped and reported as incomplete rather than being
  cut off mid-call by the platform. If you move to a Pro plan and raise
  `maxDuration`, raise `PIPELINE_BUDGET_MS` correspondingly.
- A very large request is split into `EVALUATOR_BATCH_SIZE` (default 10)
  requirement items per evaluator call, run in parallel. The "unsupported
  claims" pass only runs on the first batch — for an unusually long
  document with many instructions/facts, raising `EVALUATOR_BATCH_SIZE`
  ensures that pass sees the whole document in one call, at the cost of a
  slower (but single) evaluator call instead of several parallel ones.
- No account system by design for the pilot. History is per-browser, not
  per-person — clearing localStorage loses the link to past checks (the
  checks themselves stay in the database). Per-finding accept/ignore
  decisions are client-side only for this pass and are not restored when
  reopening a check from history; only the review results themselves are.
