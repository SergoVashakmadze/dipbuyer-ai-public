# Deploying the API (Railway)

Live: **https://dipbuyer-api-production.up.railway.app** (`/api/health`). Deployed 2026-09-17 so Persona
webhooks have a public endpoint.

## Service

Railway project **DipBuyer-AI**, service **dipbuyer-api** (the existing `dipbuyer-x402` service is
untouched). Docker build from `apps/api/Dockerfile`, which builds only the API and the workspace
packages it needs.

- The repo's root `railway.json` configures the x402 service (Nixpacks), so deploying the API from the
  repo root would build the wrong thing. The API service is deployed from a clean export of the branch
  with its own `railway.json` (`builder: DOCKERFILE`), and the service variable
  `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` — without it Railway ignored the config and tried
  Railpack, which fails on this monorepo.
- A volume is mounted at `/data`. Every data file points into it so nothing is lost on redeploy (set
  2026-09-18 — before that INVESTOR_STORE_PATH / AGENT_RUNS_PATH were documented here but NOT set, so the
  investor store lived in the image and was wiped on each deploy): `INVESTOR_STORE_PATH=/data/investors.json`,
  `AGENT_RUNS_PATH=/data/agent-runs.json`, `WATCHLIST_PATH=/data/watchlist.json`,
  `PORTFOLIO_LEDGER_PATH=/data/portfolio-ledger.json`, `PORTFOLIO_SNAPSHOTS_PATH=/data/portfolio-snapshots.json`,
  `MODELS_DIR=/data/models`, `INSIDER_RECENT_PATH=/data/insider/insider-recent.json`.
- Custom domain **api.dipbuyer.ai** (Cloudflare CNAME `api` -> `b8flg1ij.up.railway.app`, plus TXT
  `_railway-verify.api`). Proxied through Cloudflare since 2026-09-18, zone SSL/TLS mode **Full (strict)** (Railway
  serves a valid certificate). Keep `_railway-verify.api` so Railway can renew it.

Redeploy from a checkout of the branch to deploy:

```
rm -rf /tmp/api-deploy && mkdir -p /tmp/api-deploy
git archive <branch> | tar -x -C /tmp/api-deploy
cp railway.json /tmp/api-deploy/railway.json   # builder DOCKERFILE, healthcheck /api/health
cd /tmp/api-deploy && railway link -p DipBuyer-AI -s dipbuyer-api && railway up --service dipbuyer-api --detach
```

## Variables set (non-secret)

`NODE_ENV=production`, `RUNTIME_MODE=RESEARCH_ONLY`, `RUNTIME_EXECUTION=PAPER`, `BROKER=paper`, `LIVE_TRADING_ENABLED=false`,
`INSIDER_REFRESH=daily`, `MODELS_SCHEDULE=daily`, `DIGEST_SCHEDULE=weekly`, `WATCHLIST_CHECK_HOURS=6`,
`EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `APP_URL=https://dipbuyer.ai`, the data paths above,
`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `PERSONA_TEMPLATE_ID`, `SEC_EDGAR_USER_AGENT`, `ALPACA_DATA_FEED=sip`,
`RAILWAY_DOCKERFILE_PATH`.

**RESEARCH_ONLY + BROKER=paper + LIVE_TRADING_ENABLED=false means the deployed API cannot place any order,
real or paper-account**, by design. Owner instruction 2026-09-18: no real trading until the FCA licence is
granted and testing is complete. Do not raise the mode or enable live trading before that.

## Owner must add (secrets, in Railway → dipbuyer-api → Variables)

| Variable | Why |
|---|---|
| `PERSONA_API_KEY` | Turns on real Persona verification (sandbox key from app.withpersona.com → Sandbox → API). Until it is set, identity checks use the labelled demo mock and the webhook route replies "Persona is not the active identity provider". |
| `PERSONA_WEBHOOK_SECRET` | Shown once when the webhook is created. Without it, webhooks are rejected (fail closed). |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | Real prices (a paper account). Without them the API has fundamentals but no market data. |
| `RESEND_API_KEY` | Weekly digest email via Resend on mail.dipbuyer.ai (set 2026-09-18). With `EMAIL_PROVIDER=resend` the API refuses to boot without it. |
| `ADMIN_SUBJECTS` | Owner's Auth0 user ID for /admin (shown on /admin when signed in). |

## Persona webhook

Create in the **Sandbox** environment → Webhooks → Create webhook:

- **URL** `https://dipbuyer-api-production.up.railway.app/api/kyc/webhook/persona`
- **Events** everything starting `inquiry.` (approved, declined, failed, completed, marked-for-review, expired)
- Copy the signing secret into `PERSONA_WEBHOOK_SECRET`.

The sandbox also holds the IoMarkets 3.0 webhook. Both endpoints receive every inquiry in the
environment; each ignores inquiries it does not recognise.
