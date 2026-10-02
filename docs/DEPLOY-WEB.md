# Deploying the web app (Cloudflare Workers)

Live: **https://dipbuyer.ai** (apex switched 2026-09-18; `www` 308-redirects to the apex, `app.dipbuyer.ai`
also serves the app). Cloudflare Workers **free plan**, via the OpenNext adapter.

The previous site (Vercel) is no longer reachable: its DNS records were deleted so the worker could claim the
hostnames. The Vercel project itself was not touched. **Rollback:** remove the `dipbuyer.ai` and `www` custom
domains from the worker, then re-add `A dipbuyer.ai 76.76.21.21` and `CNAME www 109dfc8ffe512a7c.vercel-dns-017.com`
(DNS only). Old-site URLs still in search results redirect (next.config.mjs): `/white-paper` -> `/methodology`,
`/auto-invest` -> `/autopilot`, `/dashboard` -> `/portfolio`, `/tokens` -> `/`.

## Deploy

```
git checkout main && pnpm install --frozen-lockfile && pnpm build
cd apps/web && pnpm cf:deploy          # needs `npx wrangler login` with Workers write access
```

`pnpm cf:preview` runs the same build locally in `workerd` (Cloudflare's runtime) before deploying.

## Configuration

- `apps/web/wrangler.jsonc`: worker `dipbuyer-web`, account `090f06ae…`, custom domains `dipbuyer.ai`,
  `www.dipbuyer.ai`, `app.dipbuyer.ai` (wrangler creates and owns the DNS records; it refuses a hostname that
  already has an A/CNAME record), `nodejs_compat`, static assets.
- `apps/web/production.public.env` (copy `production.public.env.example` and fill in your own values): public build-time settings, baked into the bundle — API
  `https://api.dipbuyer.ai/api`, Auth0 domain, SPA client id, audience. **No secrets** belong here.
- Auth0 SPA "dipbuyer-web-spa": `https://dipbuyer.ai` and `https://app.dipbuyer.ai` in Allowed Callback URLs,
  Logout URLs, Web Origins and CORS (2026-09-18), next to `http://localhost:3000`. `www` needs no entry because it
  redirects before the app loads. Sign-in stays per-origin: a session on app.dipbuyer.ai does not carry to the apex.

## Verified 2026-09-18

All main pages return 200 on dipbuyer.ai and app.dipbuyer.ai; sign-in with Google works end to end against
api.dipbuyer.ai; /admin opens only for the owner's Auth0 subject (ADMIN_SUBJECTS on Railway).
