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
Exactly one view occupies the main column at a time. The dashboard is an operations view over the
requests the system actually served — volume and latency, the execution path each request took,
what the backends returned, service health, and a live activity feed.

**Every number is an observation, never an estimate.** Where something was not observed the
card says so instead of drawing a zero, and a value that is only reachable by hovering does
not exist — every chart ships a **Table** toggle showing the same data.

### Two sources, one shape

| Source | What it covers | Where it lives |
|--------|----------------|----------------|
| **Deployment** (default) | Every request this deployment served, for all users | `fedline.request_log`, read via `POST /v1/metrics` |
| **This browser** | Only the requests this browser made | `localStorage` (capped ring buffer, 300 records) |

Both record the identical record shape, so one aggregation layer serves both. The dashboard
prefers the server log and falls back to the local store — silently in behaviour, never in
labelling: the badge in the filter row always names the source actually in use, and a
capped read is flagged rather than presented as complete.

The server source needs `enable_database = true` (the request log is a Postgres table and the
`/v1/metrics` route is only created with it). Without it the dashboard runs on local data alone.

Two measurements differ by source and are labelled accordingly: the browser records the
caller's whole **round trip**, the server records its own **processing time**. The requested
export format is a browser-side signal only — the download happens in the client.

### Sections

- **Hero + KPIs** — requests in range, success rate, median/p95 response, model invocations,
  rows returned, each with a delta against the immediately preceding window of equal length
  (omitted, not faked, when there is no comparable prior window).
- **Agent operations** — request volume, response time, routing by agent type, execution
  engine mix (model call vs deterministic vs HTTP proxy), latency by pipeline stage, and
  foundation-model usage.
- **Backends & reports** — rows by use case, the concrete HTTP operations called, knowledge-base
  retrieval and its store, export/upload activity.
- **System health & validation** — endpoint and session state, recent failures, and the **Fedline
  response validation** sweep. The sweep runs here (`POST /v1/backtest`) rather than in a modal:
  pick `data` (table checks only, no model calls) or `full` (adds routing + grounding, one model
  call per case), and the card shows the verdict, the four failure classes it counts, and the full
  per-case check report — failing cases open first, skips called out as *not* passes.
- **Live activity** — the most recent requests; a row whose exchange is still in this browser's
  chat opens it and highlights it.

## Features

- Multiline input: **Enter** sends, **Shift+Enter** newline; the box auto-grows.
- Example prompts on the welcome screen to get started fast (the sidebar is navigation).
- Live "typing…" indicator with an elapsed-seconds counter (the agent path can take 10–30s).
- Graceful handling of timeouts and errors (the backend may return a fast *local* result if
  the multi-agent path exceeds API Gateway's 30s cap — see the backend notes).
- Per-section render of `meta.endpoint` / `httpMethod` and any `endpointMissingParams`, so you
  can see exactly which backend REST call each use case maps to.
- New chat (returns you to the chat view), sidebar toggle, light/dark (follows your OS theme).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup: sidebar nav, chat area, composer, dashboard mount, settings dialog |
| `styles.css` | Chat styling + the backtest result styles the dashboard renders (light/dark via `prefers-color-scheme`) |
| `app.js` | Chat state, API calls (with abort/timeout), flexible `FinalReport` rendering, view switching |
| `telemetry.js` | Local telemetry store (capped ring buffer) + the aggregation helpers both sources share |
| `charts.js` | Dependency-free SVG chart primitives (line, columns, bars, stack, sparkline, meter) |
| `dashboard.js` | The dashboard view: data source, cards, and the four sections |
| `dashboard.css` | Dashboard layout + the validated chart palette (see the note at the top of the file) |

All seven files are copied into the nginx image by the `Dockerfile` — adding one there is not
optional, since `index.html` loads them by name.

### Chart colours

The three categorical slots in `dashboard.css` are a **validated** set, not a taste call: they
were checked on all pairs against this app's real chart surfaces (`#ffffff` light, `#1f1f1f`
dark) for colour-vision separation, lightness band, chroma and contrast. The header comment in
that file records the measured numbers. A fourth categorical hue breaks the all-pairs floors —
fold a fourth class into "Other" rather than adding one. Status colours (good / warning /
serious / critical) are reserved for state, never used as a series colour, and always ship with
a glyph and a word so meaning never rests on hue alone.
