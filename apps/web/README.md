# @dipbuyer/web

Next.js 15 (App Router) + React 19. Theme per `DESIGN.md` (dark-first navy+gold, white-label overridable).

**As built (2026-09-16):** styling is plain CSS over the `DESIGN.md` tokens in `app/globals.css`; there is no
Tailwind, shadcn/ui, AG Grid or Framer Motion in `package.json` yet, whatever the target list below says.
Charts and market widgets are TradingView embeds (`components/tradingview.tsx`).

Research routes:
- `stock/[symbol]` — research page: Lynch verdict and checklist, descriptive quality profile, intrinsic value
  (Lynch + Graham), 52-week dip context, TradingView chart/financials/technicals/news, audit hash. `GET /api/research/:symbol`.
- `opportunities` — idea lists (dip buys, below intrinsic value, Lynch bargains, …) over the research universe,
  sortable table, CSV, browser-local watchlist, plus the original ad-hoc ticker screen. `GET /api/research/screener`.
- `markets` — TradingView heatmap, movers, economic calendar, full-market screener.

Phase-0 scaffold target (routes):
```
app/
  (dashboard)/        Dashboard — holdings, performance, upcoming reviews
  opportunities/      Screener results (buy/sell candidates) — AG Grid + decision cards
  portfolio/          Positions, P&L, decision history per holding
  decision/[id]/      Decision detail — verdict, thesis, criteria checklist, gauge, provenance, on-chain badge
  backtest/           Backtest studio — params, equity/drawdown charts, metrics, signed report export
  reports/            Audit packs, suitability evidence, model-governance, partner reports
  settings/           Profile, suitability, KYC, (partner) theming & config
```

Bootstrap: `create-next-app` is **not** run yet — generate in phase 0. Every recommendation/holding must expose a "Why?" drill-down (transparency = UX).
