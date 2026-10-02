# DipBuyer AI

> An autonomous AI that invests with a transparent, named value methodology — **Peter Lynch's** — and proves every decision on an immutable, independently verifiable on-chain audit trail. Available white-label to FCA-regulated UK partners.

## Monad: provable AI decisions

Every decision DipBuyer AI makes is hashed, and a whole run is anchored on **Monad testnet** as **one Merkle root**; any single decision is then provable against that root with a short inclusion proof, checked by anyone without trusting us.

- **Judges:** [`JUDGES.md`](./JUDGES.md) is a five-minute, read-only way to verify everything below.
- **Try it:** https://dipbuyer.ai/verify/monad. It hashes a decision in your browser, replays its proof, and asks the registry contract on chain. DipBuyer's servers are not contacted. The example batch is a real backtest of 53,384 decisions anchored in one transaction.
- **Contract:** `DecisionRegistry` at `0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121` (Monad testnet, chain 10143), source verified on Sourcify. Code, 23 Foundry tests and notes: [`packages/chain-monad`](./packages/chain-monad).
- **Gasless anchoring:** batch roots are sent as ERC-4337 UserOperations with gas sponsored by Alchemy's Gas Manager, so the anchoring account holds no MON. Verified end to end; see the package README.
- **Chainlink CRE:** [`cre/`](./cre) is a CRE workflow that fetches decisions from the public API, builds the Merkle root with the same code the verify page uses, and anchors it through the Chainlink forwarder and `CreAnchorReceiver` (`0x79cf4f8c9dcafe4cfe21c85c494acd5e4d0c9ab6`). Simulated with `--broadcast`: root `0x4d548a4d…3903`, tx `0xc0d62aae…badaf`. Simulated, not deployed.
- **Envio HyperIndex:** [`indexer/`](./indexer) indexes the registry's events and drives the batch list on the verify page (public RPCs cap `eth_getLogs`, so a plain event scan is not possible).
- **ERC-8004 agent identity:** registered in the canonical Identity Registry on Monad testnet as agentId **1978** (registration file: `apps/web/public/agent-registration.json`).
- **What it proves, and what it does not:** that a decision existed, unchanged, under a named version of the rules. It says nothing about whether the decision was any good.

> **Built during the Metropolis hackathon (from 17 Sep 2026):** everything Monad-related above (registry, anchoring, gasless path, CRE workflow, indexer, ERC-8004 registration, `/verify/monad`). The Lynch rules engine, backtest, web app and Algorand anchoring existed before. Everything is Monad **testnet**.

> **Not included in this copy:** the S&P 500 membership data file (see [`packages/data/vendor/README.md`](./packages/data/vendor/README.md) for how to obtain it), third-party papers and books, and internal operations notes.

## What this is
DipBuyer AI identifies undervalued listed equities, invests in them, and divests overvalued ones, applying Peter Lynch's criteria (PEG/GARP, six stock categories, "invest in what you know"). It **thinks** (classifies + scores), **acts** (executes via a regulated broker), and **proves** (emits an immutable, hash-anchored DecisionRecord for every action).

**Design heuristic:** deterministic-first — the LLM proposes; deterministic engines validate, gate, and execute. Nothing bypasses a deterministic risk/criteria gate.

## Documents
1. [`PROMPT.md`](./PROMPT.md) — the agent's constitution (system prompt) + DecisionRecord schema.
2. [`DESIGN.md`](./DESIGN.md) — design system / UX tokens.

## Monorepo layout
```
apps/
  web/        Next.js 15 app (dashboard, screener, portfolio, backtest studio, reports)
  api/        NestJS 11 API (auth, kyc, suitability, screener, decision engine, orders, backtest, audit)
  verifier/   Standalone on-chain DecisionRecord verifier (no server trust)
  bot/        Optional Telegram/WhatsApp (alerts; transactional gated by same checks)
packages/
  shared/     Types: DecisionRecord, Lynch enums, DTOs
  strategy/   Pure, deterministic Peter Lynch decision engine (unit-tested core)
  backtest/   Point-in-time, bias-controlled backtester (reuses strategy/)
  brokers/    Broker abstraction (alpaca-us, alpaca-eu, paper)
  data/        Data adapters (alpaca, financialdatasets, fred) + caching
  chain/       Algorand audit anchoring + verification
  ui/          Shared component library / design tokens
config/
  strategy.lynch.json   Canonical Lynch thresholds (single source of truth; PROMPT.md must not disagree)
```

## Getting started
```bash
nvm use                 # Node 24+
pnpm install
cp .env.example .env     # keys optional — API & web run with in-memory demo data
pnpm build               # required before running apps (conditional exports -> dist)
pnpm start:api           # API on :3001  (or: pnpm dev:api)
pnpm dev:web             # Web on :3000
# optional local infra (Postgres on :5433 + Redis): pnpm infra:up
```

### Real Postgres persistence (optional)
```bash
pnpm infra:up                                   # Postgres on host :5433
cd apps/api && pnpm exec prisma generate
DATABASE_URL=postgresql://dipbuyer:dipbuyer@localhost:5433/dipbuyer pnpm exec prisma db push
# then run the API with DATABASE_URL set -> /api/health/ready shows persistence: "postgres"
```
With `ALPACA_KEY_ID`/`ALPACA_SECRET_KEY` set (paper Trading API), the agent trades a real Alpaca paper account; otherwise it uses the in-memory PaperBroker.
Open http://localhost:3000 → Opportunities (screen tickers), Backtest, Portfolio, Suitability.

## API endpoints
- `GET  /api/health`
- `GET  /api/decisions/:symbol?asOf=` — analyse one symbol (public research)
- `GET  /api/decisions` — recent persisted decisions (audit trail)
- `POST /api/decisions/screen` — ranked buy candidates
- `POST /api/decisions/:symbol/anchor` — anchor latest decision hash on Algorand
- `POST /api/backtest` — point-in-time backtest (equity curve + metrics)
- `POST /api/orders` + `GET /api/portfolio` — paper execution (gated by mode + suitability)
- `POST /api/suitability` + `GET /api/suitability/:userId` — COBS 9A assessment

Auth0 JWT guard is env-gated (inert until `AUTH0_DOMAIN`+`AUTH0_AUDIENCE` set); `health` and the decision GET are public.

## Status
Working full-stack vertical slice: Lynch engine → API → web, with backtest, paper execution, on-chain audit anchoring, and suitability gating. ~50 unit tests green. **Live trading is gated on FCA legal sign-off** (internal product requirements, not published) and a full AML/KYC programme (`PRD.md` §11). Persistence is in-memory; Prisma/Postgres schema is the wired-next target.

## ⚠️ Compliance note
Regulatory content here is research-derived, **not legal advice**. The discretionary-vs-advice-vs-execution-only decision and authorisation route require a UK-authorised compliance officer / FCA solicitor. A full **AML/KYC (MLR 2017)** programme is a required pre-live workstream.

---

Copyright © 2026 Sergo Vashakmadze. **All rights reserved.** This source is published for hackathon review and evaluation only; no licence is granted to use, copy, modify or distribute it.
