# Fedline Assistant — chat frontend

A zero-build, dependency-free chat UI (ChatGPT/Claude-style) for the Bedrock agentic
reporting backend. It calls `POST /v1/ask { question }` and renders the structured
`FinalReport` flexibly: a summary, per-section collapsible cards with highlights, the
resolved backend REST endpoint, and a data table per task (plus a raw-JSON toggle).

## Sign in (authentication + session)

The API is gated: you **sign in first** and every request carries a bearer token.

1. The login screen posts `POST /v1/login { username, password }`.
2. On success the server returns a signed session token that already encodes the user's
   `officeId`, ABA and other IDs — so you never type your name or `office_id` into a question.
3. The token + user are kept in `localStorage`; each `POST /v1/ask` sends
   `Authorization: Bearer <token>` and the API's authorizer injects those IDs server-side.
4. The session lasts until the token expires (default 1h); past expiry — or on a 401 — the UI
   clears the session and returns you to the login screen. Use **Sign out** (top bar) any time.

Demo credentials (seeded in `db/schema.sql` / the in-code directory): `lliu` / `Password123!`
and `jsmith` / `Password123!`. Rotate/replace these for any real deployment.

## Hosted (AWS)

Deployed on GovCloud, served over HTTPS from a **private** S3 bucket through the existing
API Gateway (no public bucket, no CloudFront — unavailable in GovCloud — no CORS reliance):

- **URL:** `https://9r7fg2qut2.execute-api.us-gov-west-1.amazonaws.com/app`
- Infra: `terraform/web.tf` (private bucket + `web-serve` Lambda + IAM) and the `/app` routes in
  `terraform/modules/api-gateway`. The `web-serve` Lambda streams objects from the bucket and
  injects `<base href="/app/">` so relative asset URLs resolve under the mount path.
- When loaded from `/app`, the bundle calls the API **same-origin** (`/v1/ask`) automatically.

### Redeploy the UI (no Lambda change needed)

```bash
export AWS_PROFILE=679343992698_AWSAdministratorAccess AWS_REGION=us-gov-west-1
aws s3 sync web/ s3://bedrock-reporting-dev-web-679343992698 --delete --exclude README.md
```

(Infra changes go through `terraform apply`; bundle changes are just the `s3 sync` above.)

## Run it locally

The API has open CORS (`allow_origins = ["*"]`), so any of these work:

```bash
# Option A — from the repo root (downloads `serve` via npx)
npm run web          # then open http://localhost:5173

# Option B — Python, no Node needed
cd web && python -m http.server 5173    # then open http://localhost:5173

# Option C — just open web/index.html in a browser (file://). Works in most
# browsers since CORS is open; serving (A/B) is more reliable.
```

## Configure the endpoint

The default API endpoint is prefilled (the deployed GovCloud URL). Change it any time via
the **⚙ Settings** button — the endpoint and request timeout are saved in `localStorage`.

## Response formats

**Tables are the default.** To get a report in another format, either:

- **Ask for it** — include the format in your message and it's returned automatically, e.g.
  *"…as PDF"*, *"export …as Excel"*, *"…as CSV"*, *"…as JSON"*. The table preview still shows.
- **Click an export button** under any report: **CSV**, **Excel**, **PDF**, **JSON**.

Notes: exports are generated client-side from the structured report (no backend round-trip).
CSV is UTF-8 with a BOM (opens cleanly in Excel); **Excel** is an `.xls` (HTML table) — Excel may
ask to confirm the format on open; **PDF** uses the browser's print-to-PDF (a print dialog opens).

## Operations dashboard

The **left panel is the navigation**: **Dashboard** and **Chatbot**, plus New chat and Settings.
Exactly one view occupies the main column at a time.

The Dashboard itself has two tabs, because it answers two different questions from two different
sources:

| Tab | Question | Source |
|-----|----------|--------|
| **Telemetry** | What did the system *do*? Volume, latency, execution path, backend output, health, live activity. | The request log — time-windowed |
| **Backtest** | What does a chosen application *return*? The response-validation sweep. | An on-demand run of `POST /v1/backtest` |

The range and source filters live on **Telemetry** only. The sweep has no time axis and no relation
to them, so putting those controls on the Backtest tab would be a knob that governs nothing.

**Every number is an observation, never an estimate.** Where something was not observed the
card says so instead of drawing a zero, and a value that is only reachable by hovering does
not exist — every chart ships a **Table** toggle showing the same data.

### Two producers, one payload

The dashboard renders a single aggregate payload. What changes with the source is only **where the
arithmetic happened**, never what a metric means:

| Source | What it covers | Where it is computed |
|--------|----------------|----------------------|
| **Deployment** (default) | Every request this deployment served, for all users | **In SQL**, over every matching row of `fedline.request_log` (`POST /v1/metrics`) |
| **This browser** | Only the requests this browser made | In JS, over `localStorage` (capped ring buffer, 300 records) |

The database does the aggregation. The dashboard does **not** fetch raw rows and add them up —
that capped every KPI at the fetch limit, so "requests in range: 2,000" could really have meant
"2,000, and we stopped counting". There is no truncation caveat any more because there is nothing
left to truncate: the totals are the totals.

Both producers are held to the same definitions, and `src/__tests__/metrics-aggregation.test.ts`
pins the ones that are easy to get wrong on either side:

- percentiles are **linear-interpolated** (`percentile_cont`) over `latencyMs > 0` — a missing
  timing is not an observation of "0 ms";
- a **model invocation** is `engine='llm' AND status='ran'` — a skipped step never happened, and a
  fallback step means the model call *failed* and deterministic code answered;
- a **fallback step still executed**, so it counts in the engine mix even though it is not a model
  invocation — the mix's total and its "N fell back" note come from the same set;
- an **empty bucket** has a total of 0 (a real observation: no requests) but a null latency (no
  observation at all), so the line breaks instead of interpolating through it;
- an **empty prior window** yields no baseline, so the KPI shows no delta rather than "+100%".

The dashboard prefers the server and falls back to the local store — silently in behaviour, never
in labelling: the badge in the filter row always names the source actually in use.

The server source needs `enable_database = true` (the request log is a Postgres table and the
`/v1/metrics` route is only created with it). Without it the dashboard runs on local data alone.

Two measurements differ by source and are labelled accordingly: the browser records the caller's
whole **round trip**, the server records its own **processing time**. The requested export format
is a browser-side signal only — the download happens in the client.

### Telemetry tab — sections

- **Hero + KPIs** — requests in range, success rate, median/p95 response, model invocations,
  rows returned, each with a delta against the immediately preceding window of equal length
  (omitted, not faked, when there is no comparable prior window).
- **Agent operations** — request volume, response time, routing by agent type, execution
  engine mix (model call vs deterministic vs HTTP proxy), latency by pipeline stage, and
  foundation-model usage.
- **Backends & reports** — rows by use case, the concrete HTTP operations called, knowledge-base
  retrieval and its store, export/upload activity.
- **System health** — endpoint and session state, and recent failures.
- **Live activity** — the most recent requests; a row whose exchange is still in this browser's
  chat opens it and highlights it.

### Backtest tab

**Response validation** — replay a registered application's operations and grade what they return.
Run on demand (`POST /v1/backtest`) rather than from a modal.

Pick the **Application** to validate. Each option states how much of it a sweep can actually cover
(`Fedline — 18 of 18 operation(s) exercisable`), so an all-skipped result is never a surprise
discovered after running it. Then pick the **Mode**: `data` (table checks only, no model calls) or
`full` (adds routing + grounding, one model call per case).

Two kinds of suite, and the card always says which it ran:

| Suite | Applies to | What it asserts |
|-------|-----------|-----------------|
| **authored** | Fedline | Realistic parameters and real table expectations — required columns, numeric columns, rollups that must reconcile, parameters echoed back, plus an operation-coverage assertion |
| **registry** | every other registered application | Only what a registration document can justify: the call succeeded, and every row carries the same columns |

An operation is **not exercised** — reported as `SKIPPED` with its reason, never as a pass — when:

- its method is not GET/HEAD. A sweep must never fire a POST/PUT/PATCH/DELETE at a registered
  application: submitting to an endpoint is a side effect, not a test. (This is why SCP, whose only
  operation is `POST submitEasySim`, reports *Nothing exercised* rather than a green tick.)
- its required parameters have no authored values. Calling with placeholders would test the
  fixture, not the backend.

`src/__tests__/registry-cases.test.ts` pins both rules.

**Run again** repeats the sweep; **Clear results** discards the retained verdict and returns the
card to its not-run state — no sweep runs and nothing on the server is touched. Clear only appears
once there is a result to clear. A verdict belongs to the application that produced it: switching
the picker never shows one application's result under another's heading. The verdict is retained
across tab switches and reloads, because a `full` sweep costs one model call per case and should
not be re-run just to look at it again.

### Chart colours

The three categorical slots in `dashboard.css` are a **validated** set, not a taste call: they
were checked on all pairs against this app's real chart surfaces (`#ffffff` light, `#1f1f1f`
dark) for colour-vision separation, lightness band, chroma and contrast. The header comment in
that file records the measured numbers. A fourth categorical hue breaks the all-pairs floors —
fold a fourth class into "Other" rather than adding one. Status colours (good / warning /
serious / critical) are reserved for state, never used as a series colour, and always ship with
a glyph and a word so meaning never rests on hue alone.
