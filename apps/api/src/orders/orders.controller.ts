import { randomUUID } from "node:crypto";
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Post, Req } from "@nestjs/common";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import type { IBroker } from "@dipbuyer/brokers";
import { allocationFromConfig, attribute, checkRisk, markPosition, performanceSeries } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import type { IntendedAction, RuntimeMode } from "@dipbuyer/shared";
import { loadStrategyConfig } from "@dipbuyer/strategy";
import { BROKER } from "./orders.providers.js";
import { MARKET_DATA } from "./market-data.provider.js";
import { SuitabilityService } from "../suitability/suitability.service.js";
import { KycService } from "../kyc/kyc.service.js";
import { LEDGER_STORE, LedgerStore, SNAPSHOT_STORE, SnapshotStore } from "./portfolio.store.js";

interface PlaceOrderBody {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  limitPrice?: number;
  idempotencyKey?: string;
  userId?: string;
}

/**
 * Paper execution endpoints (the "acts" pillar). Guarded by the global AuthGuard when Auth0 is
 * configured. Execution is gated to PAPER unless live trading is explicitly enabled (and, in
 * future, the client mandate + suitability are VALID). Orders carry an idempotency key.
 */
@Controller()
export class OrdersController {
  constructor(
    @Inject(BROKER) private readonly broker: IBroker,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataAdapter,
    private readonly suitability: SuitabilityService,
    private readonly kyc: KycService,
    @Optional() @Inject(LEDGER_STORE) private readonly ledger: LedgerStore = new LedgerStore(),
    @Optional() @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore = new SnapshotStore(),
  ) {}

  @Post("orders")
  async place(@Body() body: PlaceOrderBody, @Req() req?: AuthedRequest) {
    if (process.env.RUNTIME_EXECUTION === "LIVE" && process.env.LIVE_TRADING_ENABLED !== "true") {
      throw new ForbiddenException("Live trading not enabled (LIVE_TRADING_ENABLED=false)");
    }
    const mode = (process.env.RUNTIME_MODE as RuntimeMode) ?? "RESEARCH_ONLY";
    if (mode === "RESEARCH_ONLY") {
      throw new ForbiddenException("Execution not permitted in RESEARCH_ONLY mode");
    }
    // COBS 9A + MLR 2017: advised/discretionary execution requires a valid KYC and suitability.
    if (mode === "ADVISORY" || mode === "DISCRETIONARY") {
      // With Auth0 on, the verified token subject is the user; a body userId cannot impersonate.
      if (req?.user?.sub) body = { ...body, userId: resolveUserId(req, body?.userId) };
      if (!body?.userId) {
        throw new ForbiddenException("userId is required for execution");
      }
      if (!this.kyc.isValid(body.userId)) {
        throw new ForbiddenException("KYC verification is required before execution");
      }
      if (!this.suitability.isValid(body.userId)) {
        throw new ForbiddenException("A valid suitability assessment is required before execution");
      }
    }
    if (!body?.symbol || !body?.side || !body?.qty) {
      throw new BadRequestException("symbol, side and qty are required");
    }
    const symbol = body.symbol.toUpperCase();
    // Market orders fill at the current market price (Alpaca or demo source).
    const fillPrice = body.limitPrice ?? (await this.marketData.getLatestPrice(symbol));

    // One account: spare money sits in the index core, so a buy of your own is funded by selling just
    // enough of the core. Without this, every self-directed buy after an agent run hit the cash floor.
    let fundedFromCore: { symbol: string; qty: number; notional: number } | null = null;
    if (body.side === "buy") {
      const { config } = loadStrategyConfig();
      const core = allocationFromConfig(config.portfolio_construction).coreSymbol;
      const floorPct = Number(config.risk_guardrails["min_cash_floor_pct"] ?? 0);
      const cashNow = await this.broker.getCash();
      const held = await this.broker.getPositions();
      let equity = cashNow;
      for (const p of held) equity += p.qty * (await this.marketData.getLatestPrice(p.symbol).catch(() => p.avgEntryPrice));
      const shortfall = body.qty * fillPrice - (cashNow - (equity * floorPct) / 100);
      const corePos = held.find((p) => p.symbol === core && p.qty > 0);
      if (shortfall > 0 && corePos && symbol !== core) {
        const corePrice = await this.marketData.getLatestPrice(core).catch(() => corePos.avgEntryPrice);
        const whole = this.broker.id !== "paper";
        const want = (shortfall / corePrice) * 1.002; // a sliver over, so rounding cannot leave it short
        const qty = Math.min(corePos.qty, whole ? Math.ceil(want) : Math.ceil(want * 1e4) / 1e4);
        const key = `${body.idempotencyKey ?? randomUUID()}:fund-core`;
        const sold = await this.broker.placeOrder({ symbol: core, side: "sell", qtyOrNotional: String(qty), orderType: "limit", limitPrice: String(corePrice), idempotencyKey: key } as IntendedAction & { symbol: string });
        await this.ledger.record({
          id: key, ts: new Date().toISOString(), userId: body.userId ?? resolveUserIdSafe(req), source: "core", symbol: core, side: "sell",
          qty, price: corePrice, status: sold.status, brokerOrderId: sold.brokerOrderId,
        });
        fundedFromCore = { symbol: core, qty, notional: qty * corePrice };
      }
    }

    // Pre-trade risk engine (deterministic guardrails from config/strategy.lynch.json).
    if (body.side === "buy") {
      const { config } = loadStrategyConfig();
      const g = config.risk_guardrails;
      const cash = await this.broker.getCash();
      const positions = await this.broker.getPositions();
      const positionValues: Record<string, number> = {};
      for (const p of positions) {
        const px = await this.marketData.getLatestPrice(p.symbol).catch(() => p.avgEntryPrice);
        positionValues[p.symbol] = p.qty * px;
      }
      const verdict = checkRisk(
        { side: "buy", symbol, notional: body.qty * fillPrice, cash, positionValues },
        {
          maxPositionPct: Number(g["max_position_pct_of_portfolio"] ?? 100),
          minCashFloorPct: Number(g["min_cash_floor_pct"] ?? 0),
        },
      );
      if (!verdict.ok) throw new ForbiddenException(verdict.reason);
    }

    const action: IntendedAction & { symbol: string } = {
      symbol,
      side: body.side,
      qtyOrNotional: String(body.qty),
      orderType: "limit",
      limitPrice: String(fillPrice),
      idempotencyKey: body.idempotencyKey ?? randomUUID(),
    };
    const result = await this.broker.placeOrder(action);
    // An order placed here is the investor's own decision ("self"), tracked apart from the agent's.
    await this.ledger.record({
      id: action.idempotencyKey,
      ts: new Date().toISOString(),
      userId: body.userId ?? resolveUserIdSafe(req),
      source: "self",
      symbol,
      side: body.side,
      qty: Number(result.filledQty) > 0 ? Number(result.filledQty) : body.qty,
      price: Number(result.filledAvgPrice) > 0 ? Number(result.filledAvgPrice) : fillPrice,
      status: result.status,
      brokerOrderId: result.brokerOrderId,
    });
    return fundedFromCore ? { ...result, fundedFromCore } : result;
  }

  @Get("portfolio")
  async portfolio() {
    const positions = await this.broker.getPositions();
    const prices = new Map<string, number>();
    // Mark to market at current prices using the pure valuation helper.
    const marked = await Promise.all(
      positions.map(async (p) => {
        const price = await this.marketData.getLatestPrice(p.symbol).catch(() => p.avgEntryPrice);
        prices.set(p.symbol.toUpperCase(), price);
        return markPosition(p, price);
      }),
    );
    const cash = await this.broker.getCash();
    const attribution = attribute(await this.ledger.all(), positions, (s) => prices.get(s) ?? 0);
    // Reading the portfolio also records today's snapshot (one per day), which feeds the chart.
    const equity = cash + marked.reduce((t, p) => t + p.marketValue, 0);
    const benchmarkSymbol = allocationFromConfig(loadStrategyConfig().config.portfolio_construction).coreSymbol;
    const benchmark = prices.get(benchmarkSymbol) ?? (await this.marketData.getLatestPrice(benchmarkSymbol).catch(() => null));
    await this.snapshots.upsert({
      date: new Date().toISOString().slice(0, 10),
      equity,
      cash,
      sleeves: Object.fromEntries(attribution.sleeves.map((s) => [s.sleeve, s.value])),
      benchmark,
    });
    return {
      cash,
      positions: marked.map((p) => ({ ...p, bySource: attribution.bySymbol[p.symbol.toUpperCase()] ?? [] })),
      sleeves: attribution.sleeves,
      benchmarkSymbol,
    };
  }

  /** Daily snapshots rebased to 100 against the benchmark (the core ETF). */
  @Get("portfolio/performance")
  async performance() {
    const snapshots = await this.snapshots.all();
    return {
      benchmarkSymbol: allocationFromConfig(loadStrategyConfig().config.portfolio_construction).coreSymbol,
      series: performanceSeries(snapshots),
      snapshots: snapshots.sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
  }
}

/** User id for the ledger: the verified subject when signed in, else the local-dev default. */
function resolveUserIdSafe(req?: AuthedRequest): string {
  try {
    return resolveUserId(req);
  } catch {
    return "unknown";
  }
}
