# Reporting Assistant — chat frontend

A zero-build, dependency-free chat UI (ChatGPT/Claude-style) for the Bedrock agentic
reporting backend. It calls `POST /v1/ask { question }` and renders the structured
`FinalReport` flexibly: a summary, per-section collapsible cards with highlights, the
resolved backend REST endpoint, and a data table per task (plus a raw-JSON toggle).

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
