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

## 6. Run the golden-dataset evaluation

Once your `.env.local` has a real `OPENROUTER_API_KEY`:

```bash
npm run eval
```

This runs all 32 cases in `evaluation/golden_cases.json` against your live
provider and prints precision, recall, false-positive rate, evidence
accuracy, and suggestion-grounding accuracy. It writes a timestamped result
to `evaluation/results/`. To lock in a baseline for future regression
detection:

```bash
cp evaluation/results/run-<timestamp>.json evaluation/results/baseline.json
```

Re-run `npm run eval` any time you change `lib/prompts.ts` or a validator —
it will tell you if recall dropped or the false-positive rate rose
compared to the baseline, and exit with code 1 (wire this into CI).

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
  judgment than a frontier model. `lib/llm/openrouter.ts` has best-effort
  JSON extraction (handles markdown fences and prose wrapping), but a
  sufficiently non-compliant model can still throw `invalid_response`,
  which is surfaced the same honest way.
- No account system by design for the pilot (see spec). History is
  per-browser, not per-person — clearing localStorage loses the link to
  past checks (the checks themselves stay in the database).
