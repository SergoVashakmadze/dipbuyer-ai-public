import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IBroker, OrderResult, Position } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import { OrdersController } from "./orders.controller.js";
import { SuitabilityService } from "../suitability/suitability.service.js";
import { KycService } from "../kyc/kyc.service.js";

/** Minimal in-memory broker; placeOrder is spied so we can assert it is / isn't reached. */
function fakeBroker(over: Partial<IBroker> = {}): IBroker & { placeOrder: ReturnType<typeof vi.fn> } {
  const placeOrder = vi.fn(
    async (): Promise<OrderResult> => ({ brokerOrderId: "o1", clientOrderId: "c1", status: "filled", filledQty: 1, filledAvgPrice: 10 }),
  );
  return {
    placeOrder,
    getPositions: async (): Promise<Position[]> => [],
    getCash: async () => 100_000,
    ...over,
  } as IBroker & { placeOrder: ReturnType<typeof vi.fn> };
}

const marketData: MarketDataAdapter = {
  getBars: async () => [],
  getLatestPrice: async () => 10,
};

const ENV_KEYS = ["RUNTIME_EXECUTION", "LIVE_TRADING_ENABLED", "RUNTIME_MODE", "KYC_PROVIDER"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/** Build a controller with a verified user (KYC + suitability) ready for ADVISORY/DISCRETIONARY. */
async function controllerWithVerifiedUser(userId = "u1", broker = fakeBroker()) {
  const suitability = new SuitabilityService();
  const kyc = new KycService();
  process.env.KYC_PROVIDER = "mock"; // auto-approves
  await kyc.start(userId);
  suitability.assess({ userId, objectives: "growth", riskTolerance: "medium", capacityForLoss: "medium", knowledgeExperience: "informed" });
  return { ctrl: new OrdersController(broker, marketData, suitability, kyc), broker, suitability, kyc };
}

const order = (over = {}) => ({ symbol: "aapl", side: "buy" as const, qty: 10, limitPrice: 10, userId: "u1", ...over });

describe("OrdersController execution gating", () => {
  it("blocks LIVE execution unless LIVE_TRADING_ENABLED=true", async () => {
    process.env.RUNTIME_EXECUTION = "LIVE";
    delete process.env.LIVE_TRADING_ENABLED;
    const { ctrl, broker } = await controllerWithVerifiedUser();
    await expect(ctrl.place(order())).rejects.toThrow(/Live trading not enabled/);
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it("blocks all execution in RESEARCH_ONLY mode (the default)", async () => {
    delete process.env.RUNTIME_MODE; // defaults to RESEARCH_ONLY
    const { ctrl } = await controllerWithVerifiedUser();
    await expect(ctrl.place(order())).rejects.toThrow(/RESEARCH_ONLY/);
  });

  it("requires userId for ADVISORY/DISCRETIONARY execution", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const { ctrl } = await controllerWithVerifiedUser();
    await expect(ctrl.place(order({ userId: undefined }))).rejects.toThrow(/userId is required/);
  });

  it("blocks execution when KYC is not valid", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const suitability = new SuitabilityService();
    const kyc = new KycService(); // user never started → PENDING
    suitability.assess({ userId: "u1", objectives: "g", riskTolerance: "low", capacityForLoss: "low", knowledgeExperience: "basic" });
    const ctrl = new OrdersController(fakeBroker(), marketData, suitability, kyc);
    await expect(ctrl.place(order())).rejects.toThrow(/KYC verification is required/);
  });

  it("blocks execution when suitability is not valid", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    process.env.KYC_PROVIDER = "mock";
    const suitability = new SuitabilityService(); // never assessed
    const kyc = new KycService();
    await kyc.start("u1");
    const ctrl = new OrdersController(fakeBroker(), marketData, suitability, kyc);
    await expect(ctrl.place(order())).rejects.toThrow(/suitability assessment is required/);
  });

  it("rejects malformed orders once gates pass", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const { ctrl } = await controllerWithVerifiedUser();
    await expect(ctrl.place(order({ qty: 0 }))).rejects.toThrow(/symbol, side and qty are required/);
  });

  it("places a valid buy within risk limits (symbol upper-cased, idempotency key set)", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    const { ctrl, broker } = await controllerWithVerifiedUser();
    const res = await ctrl.place(order({ symbol: "aapl", qty: 10, limitPrice: 10 }));
    expect(res.status).toBe("filled");
    expect(broker.placeOrder).toHaveBeenCalledTimes(1);
    const action = broker.placeOrder.mock.calls[0]![0] as { symbol: string; idempotencyKey: string };
    expect(action.symbol).toBe("AAPL");
    expect(action.idempotencyKey).toBeTruthy();
  });

  it("blocks a buy that breaches the position cap (pre-trade risk engine)", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    // notional 1,000,000 on a 100k portfolio >> 10% cap → ForbiddenException from checkRisk.
    const { ctrl, broker } = await controllerWithVerifiedUser();
    await expect(ctrl.place(order({ qty: 100_000, limitPrice: 10 }))).rejects.toThrow(/[Pp]osition cap/);
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it("portfolio() marks positions to market", async () => {
    const broker = fakeBroker({
      getPositions: async () => [{ symbol: "AAPL", qty: 5, avgEntryPrice: 8, marketValue: 40 }] as Position[],
      getCash: async () => 1_000,
    });
    const { ctrl } = await controllerWithVerifiedUser("u1", broker);
    const pf = await ctrl.portfolio();
    expect(pf.cash).toBe(1_000);
    expect(pf.positions[0]!.symbol).toBe("AAPL");
    expect(pf.positions[0]!.marketValue).toBe(50); // 5 * latest price 10
  });
});

describe("OrdersController self-directed investing and portfolio attribution", () => {
  it("records the investor's own orders as 'self' in the ledger", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const { ctrl } = await controllerWithVerifiedUser();
    await ctrl.place(order());
    const pf = await ctrl.portfolio();
    expect(pf.sleeves).toEqual([]); // the fake broker holds nothing, so nothing to attribute yet
    const ledger = (ctrl as unknown as { ledger: { all(): Promise<Array<{ source: string; symbol: string; userId: string }>> } }).ledger;
    expect(await ledger.all()).toEqual([expect.objectContaining({ source: "self", symbol: "AAPL", userId: "u1" })]);
  });

  it("splits the portfolio by source and snapshots it once a day", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const positions: Position[] = [{ symbol: "AAPL", qty: 1, avgEntryPrice: 10, marketValue: 10, unrealizedPl: 0 }];
    const { ctrl } = await controllerWithVerifiedUser("u1", fakeBroker({ getPositions: async () => positions }));
    await ctrl.place(order({ qty: 1 }));
    const pf = await ctrl.portfolio();
    expect(pf.sleeves).toEqual([expect.objectContaining({ sleeve: "self", value: 10, positions: 1 })]);
    expect(pf.positions[0]!.bySource).toEqual([{ sleeve: "self", qty: 1, cost: 10, value: 10 }]);
    await ctrl.portfolio(); // same day: replaces, does not append
    const perf = await ctrl.performance();
    expect(perf.snapshots).toHaveLength(1);
    expect(perf.series).toEqual([{ date: perf.snapshots[0]!.date, portfolio: 100, benchmark: 100 }]);
  });
});

describe("OrdersController funds self-directed buys from the core", () => {
  it("sells just enough SPY to keep the cash floor, and records it as a core sale", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    // $100k book: $98k of SPY at $10, $2k cash (exactly the 2% floor). Buying $1,000 of AAPL needs ~$1,000 of SPY sold.
    let cash = 2_000;
    let spy = 9_800;
    const broker = fakeBroker({
      id: "paper",
      getCash: async () => cash,
      getPositions: async (): Promise<Position[]> => [{ symbol: "SPY", qty: spy, avgEntryPrice: 10, marketValue: spy * 10, unrealizedPl: 0 }],
      placeOrder: vi.fn(async (a: { side: string; symbol: string; qtyOrNotional: string; limitPrice: string }) => {
        const q = Number(a.qtyOrNotional), px = Number(a.limitPrice);
        if (a.side === "sell") { cash += q * px; spy -= q; } else cash -= q * px;
        return { brokerOrderId: `o-${a.symbol}`, clientOrderId: "c", status: "filled", filledQty: q, filledAvgPrice: px };
      }),
    } as unknown as Partial<IBroker>);
    const { ctrl } = await controllerWithVerifiedUser("u1", broker);
    const res = (await ctrl.place(order({ qty: 100 }))) as { fundedFromCore?: { symbol: string; notional: number } };
    expect(res.fundedFromCore).toMatchObject({ symbol: "SPY" });
    expect(res.fundedFromCore!.notional).toBeGreaterThanOrEqual(1_000);
    expect(res.fundedFromCore!.notional).toBeLessThan(1_010);
    const ledger = (ctrl as unknown as { ledger: { all(): Promise<Array<{ source: string; side: string }>> } }).ledger;
    expect((await ledger.all()).map((e) => `${e.source}:${e.side}`)).toEqual(["core:sell", "self:buy"]);
  });
});
