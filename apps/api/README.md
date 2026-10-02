# @dipbuyer/api

NestJS 10 backend (reuse IoMarkets.io 3.0 module structure). Phase-0 scaffold target:

```
src/modules/
  auth/         Auth0 JWT (web) + M2M (agents), RBAC, MFA
  kyc/          IKycProvider (auth0 | entrust | persona | mock)
  suitability/  COBS 9A/10A questionnaire → Suitability record (gates ADVISORY/DISCRETIONARY)
  tenancy/      multi-tenant isolation + theming/config
  assets/       universe sync (survivorship-bias-free)
  screener/     runs @dipbuyer/strategy over the universe
  decision/     DecisionEngine: LLM propose → strategy validate → risk gate → DecisionRecord
  orders/       @dipbuyer/brokers + idempotency + reconciliation
  portfolio/    positions, cash, P&L, decision history
  backtest/     @dipbuyer/backtest runner + signed reports
  audit/        immutable AuditEvent (DB trigger) + @dipbuyer/chain anchoring
  reporting/    audit packs, suitability evidence, model-governance, partner reports
```

Bootstrap: `nest new` is **not** run yet — generate in phase 0, then wire the modules above. DB via Prisma + Postgres 16 + pgvector; queues via BullMQ/Redis.
