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

## Features

- Multiline input: **Enter** sends, **Shift+Enter** newline; the box auto-grows.
- Example prompts in the sidebar / welcome screen to get started fast.
- Live "typing…" indicator with an elapsed-seconds counter (the agent path can take 10–30s).
- Graceful handling of timeouts and errors (the backend may return a fast *local* result if
  the multi-agent path exceeds API Gateway's 30s cap — see the backend notes).
- Per-section render of `meta.endpoint` / `httpMethod` and any `endpointMissingParams`, so you
  can see exactly which backend REST call each use case maps to.
- New chat, sidebar toggle, light/dark (follows your OS theme).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup: sidebar, chat area, composer, settings dialog |
| `styles.css` | All styling (light/dark via `prefers-color-scheme`) |
| `app.js` | Chat state, API call (with abort/timeout), flexible `FinalReport` rendering |
