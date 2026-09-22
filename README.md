# SanityGate — public pilot

SanityGate checks AI-generated content against its source and requirements,
highlights what doesn't align, cites the source evidence, and suggests a
correction — without an account, without needing Claude, and without
exposing any secret to the browser.

This is a real, runnable Next.js project. It is **not deployed by default**
— follow the steps below to put it online. Nothing here calls a live LLM
or a live database until you provide real credentials in step 2–3.

## Architecture

```
Browser (no secrets)
   -> POST /api/check                (Next.js server route, runs on the server)
        -> Layer 1: deterministic validators (lib/validators/deterministic.ts)
        -> Layer 2/3: LLM evaluator   (lib/prompts.ts + lib/llm/*)
        -> Layer 4: LLM verifier      (independent second call)
        -> dedupe -> structured result
        -> persisted to Supabase (lib/supabase.ts)
   <- JSON result (findings, evidence, suggestions, confidence)
```

The LLM is only ever called from `app/api/*/route.ts`, which run server-side.
`OPENROUTER_API_KEY` never ships to the browser — check your browser's
Network tab after deploying if you want to confirm this yourself; the
request to OpenRouter happens on Vercel's servers, not the visitor's machine.

`lib/llm/provider.ts` defines a provider-agnostic `LLMProvider` interface.
`lib/llm/openrouter.ts` is the only implementation today. To add Gemini,
Anthropic, or OpenAI later, implement `LLMProvider` in a new file under
`lib/llm/` and add one case to `lib/llm/index.ts` — nothing else changes.

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
     (`0001_sync_two_box_schema.sql`, then `0002_add_check_status.sql` —
     both idempotent, safe to run once or re-run), then re-run
     `db/schema.sql`.
3. Under Project Settings → API, copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (not the anon key) → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is server-only and bypasses Row Level Security —
that's intentional (see `db/schema.sql` for why RLS is enabled with no
policies: the anon key, if it ever leaked, would have zero table access).

## 3. LLM provider (OpenRouter)

1. Create a free account at https://openrouter.ai and generate an API key
   under https://openrouter.ai/keys → `OPENROUTER_API_KEY`.
2. Check https://openrouter.ai/models?max_price=0 for the current list of
   free models and pick one with a decent context window and reliable
   instruction-following. Set it as `OPENROUTER_MODEL`.
   **This list changes over time** — a model that's free today may not be
   tomorrow. The provider abstraction makes swapping trivial; you are not
   locked into whatever is in `.env.example`.
3. Set `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` to your real deployed
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

Visit http://localhost:3000. The check screen works fully deterministic-only
even with no LLM key configured (it just tells you semantic checks are
unavailable, never fakes a clean result — see `lib/pipeline.ts`).

## 6. Run the tests

Two separate test layers, deliberately kept separate:

```bash
npm run test:unit   # no network/API key needed — runs in seconds
npm run eval        # requires a real OPENROUTER_API_KEY — makes live LLM calls
```

**`npm run test:unit`** (`test/`) — pure logic tests against the deterministic
numeric validator, the pipeline's failure-handling behavior (mocked
providers, no network), and JSON-salvage parsing. These need no API key
and are safe to run in CI on every commit; they're what caught several
real bugs (a broken relative import, a boolean-coercion bug, string-vs-
numeric comparison bugs in the old numeric validator) before this README
was even written. Run this first — if it fails, `npm run eval` isn't
worth running yet.

**`npm run eval`** (`evaluation/`) — runs all 60 cases in
`evaluation/golden_cases.json` against your live provider and prints
precision, recall, false-positive rate, evidence accuracy, suggestion-
grounding accuracy, and requirement-extraction accuracy. It writes a
timestamped result to `evaluation/results/`. To lock in a baseline for
future regression detection:

```bash
cp evaluation/results/run-<timestamp>.json evaluation/results/baseline.json
```

Re-run `npm run eval` any time you change a prompt in `lib/prompts.ts` or
a validator — it will tell you if recall dropped or the false-positive
rate rose compared to the baseline, and exit with code 1 (wire this into
CI). Re-run `npm run test:unit` on every commit; `npm run eval` whenever
you touch a prompt or validator and have API budget to spend on it.

### Diagnosing a semantic-review failure in production

If the app ever shows "SanityGate couldn't complete the semantic
review," check the Vercel function logs for a line starting
`[sanitygate:<stage>]` — `stage` is one of `extraction`, `evaluator`, or
`verifier`, telling you exactly which of the three LLM calls failed and
why (timeout, rate limit, upstream HTTP error, or a JSON parse failure —
including whether a *partial* result was salvaged from a truncated
response before giving up entirely). These logs never include prompt
text, source/output content, or API keys — only the failing stage,
model name, HTTP status/error code, and response-length/truncation
diagnostics.

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
2. Run the landing page's "See an example" check.
3. Confirm the result includes findings with `"source": "semantic"` in
   the browser's Network tab response for `/api/check` — that confirms a
   real LLM call happened, not just deterministic checks.
4. Open `/admin`, paste your `ADMIN_API_KEY`, click **Run checker
   evaluation**, and confirm real precision/recall numbers come back.

## What's stored, and what isn't

- `checks`: source text, output text, requirements, and findings — needed
  to show history. Raw text is **not** included in any aggregate analytics
  query (`app/api/admin/stats/route.ts` only ever selects `findings`,
  `has_source`, `semantic_error`, timestamps — never `source`/`output`).
- No account system. A random UUID is generated client-side and stored in
  `localStorage` so a returning visitor sees their own history; it is not
  tied to an email or any identity.
- Whatever OpenRouter's free-tier model provider does with submitted
  prompts is governed by **their** terms, not this project's — check
  https://openrouter.ai/privacy and your chosen model's provider page
  before pasting confidential material, and say so on your own pilot's
  landing/privacy copy. This app does not claim "your data is never
  stored" anywhere, because that would not be true across every layer.
- `app_config.retention_days` documents an intended retention window; no
  scheduled deletion job ships by default (see comment in `db/schema.sql`)
  — add a Supabase cron job before treating this as a real retention
  policy.

## Known limitations

- Rate limiting is per-IP via a Postgres counter (`db/schema.sql` →
  `increment_rate_limit`), which is correct across Vercel's serverless
  instances (an in-memory counter would not be, since each invocation can
  land on a different instance). It fails open if Supabase is unreachable.
- Free OpenRouter models are rate-limited by OpenRouter itself, independent
  of this app's own per-IP limit. A `429` from OpenRouter surfaces to the
  user as "SanityGate has temporarily reached its free AI capacity" —
  never as a fake "no issues found" (`lib/pipeline.ts` sets
  `semanticError`, and the UI renders it explicitly).
- Small/free models are less reliable at strict JSON output and nuanced
  judgment than a frontier model. `lib/llm/openrouter.ts` now salvages a
  partial result when a response is truncated mid-array (the most common
  failure on long documents with small free models, since it means
  `max_tokens` ran out before the model finished listing every finding),
  but a sufficiently non-compliant or slow model can still throw
  `invalid_response` or `timeout`, which is surfaced the same honest way.
- **Vercel function time budget**: `app/api/check/route.ts` sets
  `maxDuration = 60` (the ceiling on Vercel's free/hobby tier). The
  pipeline makes three sequential LLM calls (extraction, evaluator,
  verifier — the verifier now also independently re-inspects the source
  material, not just rubber-stamping candidates, so it needs a real token
  budget too); their per-call timeouts are deliberately set to sum to
  well under 60s (8s + 24s + 22s = 54s, leaving ~6s headroom for the
  Supabase write and response serialization). This is a real constraint,
  not just a tuning choice: a slow free model on a genuinely long
  document can still hit these per-call timeouts before finishing, which
  surfaces as an honest `timeout` semantic-review failure rather than a
  truncated JSON parse failure — but it means very long documents on a
  slow model may fail more often than they would with a longer budget. If
  this becomes a real pilot issue, the fix is a Vercel Pro plan
  (`maxDuration` up to 300s) with correspondingly longer per-call
  timeouts in `lib/pipeline.ts`, not a code change.
- **Verify `OPENROUTER_MODEL` is a real, specific model slug.** A
  production run once logged `model=openrouter/free` and produced an
  empty response body with `finish_reason=length` on the extraction call
  — `openrouter/free` is not a real OpenRouter model ID (real free-tier
  slugs look like `meta-llama/llama-3.1-8b-instruct:free`); if this value
  ends up in your Vercel environment variables, whatever OpenRouter routes
  it to is undefined behavior, not a specific, testable model. An empty
  completion at `finish_reason=length` is also the classic signature of a
  reasoning-capable model spending its entire token budget on hidden
  "thinking" before ever emitting the JSON answer — `lib/llm/openrouter.ts`
  now sends `reasoning: {exclude: true}` on every call as a best-effort
  mitigation (harmless no-op for models that don't support it, **not
  verified against a live call** in this environment), but picking a
  plain instruct model (not a reasoning model) for `OPENROUTER_MODEL` is
  the more reliable fix. Check https://openrouter.ai/models?max_price=0
  for the current list before deploying.
- No account system by design for the pilot (see spec). History is
  per-browser, not per-person — clearing localStorage loses the link to
  past checks (the checks themselves stay in the database).
