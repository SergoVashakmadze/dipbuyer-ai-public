# Investing agent

The agent turns Lynch-engine verdicts into trades. The engine decides; the agent only plans, sizes
and (when permitted) places orders. UI: `/agent` (top navigation). API: `apps/api/src/agent/`.

## Flow

1. **Screen**: every symbol in the universe plus everything held is analysed with the Lynch engine
   (each decision is stored and hashed as usual). Default universe = the research universe
   (`RESEARCH_UNIVERSE` or the 36 hand-picked large caps); the page also takes custom tickers.
2. **Plan**: `planTrades` proposes buys (buy verdict, not held) and sells (held, now sell / avoid / trim).
3. **Size**: `sizeBuys` (`packages/brokers/src/sizing.ts`) applies the backtest's rule: equal weight across
   `min(max_positions, held + candidates)`, highest conviction first, each buy clamped by the per-name
   cap, the cash floor and the sector cap from `config/strategy.lynch.json` `risk_guardrails`
   (40 positions, 10%, 2%, 30%). Sell proceeds count as available cash. Fractional shares on the paper
   broker, whole shares on Alpaca. A proposal that cannot be sized is kept with its reason.
4. **Review and approve** (`POST /api/agent/runs/:id/approve`): a verified investor ticks proposals and
   confirms. Sells go first. Every buy is re-checked against the live book at approval and shrunk to
   today's limits if prices moved (never refused just for being at the edge of a cap).
5. **Record**: the run (decisions, proposals, sizing, who approved what, broker results) is stored.

## Who can do what

| Setting | Plan | Approve | Agent executes on its own |
|---|---|---|---|
| `RUNTIME_MODE=RESEARCH_ONLY` (default) | yes | no | no |
| `RUNTIME_MODE=ADVISORY` | yes | yes, with valid KYC + suitability for the approving user | no |
| `RUNTIME_MODE=DISCRETIONARY` | yes | yes, same checks | yes (`POST /api/agent/run`, or a schedule with auto-execute) |
| `RUNTIME_HALT=true` | yes | no | no |
| `RUNTIME_EXECUTION=LIVE` without `LIVE_TRADING_ENABLED=true` | yes | no | no |

The approving user is the Auth0 subject when signed in, else `demo-user` (the Onboarding page uses the
same id, so onboarding once enables approvals locally).

## Schedule

`AGENT_SCHEDULE=daily|weekly|monthly` (weekdays, `AGENT_SCHEDULE_TIME_UTC`, default 21:30 after the US
close; monthly = first weekday, matching the backtest). Scheduled runs only plan and wait for approval,
unless `AGENT_SCHEDULE_AUTO_EXECUTE=true` and the API is in DISCRETIONARY mode. Switching autonomous
trading on is deliberately a deployment setting, not a button.

## Idempotency

Each order's key is `agent:<runId>:<proposalId>`: retrying an approval cannot double-fill, and a later
run can buy a name again. (The old key, `agent-buy-<SYMBOL>-PAPER`, blocked any later re-buy.)

## Try it locally without touching Alpaca

```
BROKER=paper RUNTIME_MODE=ADVISORY KYC_PROVIDER=mock AGENT_RUNS_PATH=/tmp/agent-runs.json node apps/api/dist/main.js
```
Complete Onboarding (identity + suitability), then open `/agent`, Screen & plan, select, Review, Confirm.

## Known gaps

- KYC and suitability records are in memory: after an API restart the investor must onboard again.
- Runs persist to a JSON file, not Postgres (`AGENT_RUNS_PATH`); the Prisma schema has no run model yet.
- No per-user portfolios: every approval trades the single configured broker account.
- Discretionary execution does not check a per-client mandate beyond `RUNTIME_MODE`.
