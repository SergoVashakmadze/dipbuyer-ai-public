import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAgentRunStore, type DecisionService } from "@dipbuyer/agent";
import type { IBroker, OrderResult, Position } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import { AgentService } from "./agent.service.js";
import { AgentScheduler } from "./agent.scheduler.js";
import { SuitabilityService } from "../suitability/suitability.service.js";
import { KycService } from "../kyc/kyc.service.js";

type Verdict = "buy" | "sell" | "avoid" | "trim" | "hold" | "abstain";

/** DecisionService fake with inputs: per-symbol verdict, conviction and SIC; unknown symbols throw. */
function fakeDecisions(map: Record<string, { verdict: Verdict; convictionScore: number; sic?: string }>): DecisionService {
  const out = (symbol: string) => {
    const d = map[symbol];
    if (!d) throw new Error(`no data for ${symbol}`);
    return { record: { verdict: d.verdict, convictionScore: d.convictionScore, lynchCategory: "stalwart" }, hash: `h-${symbol}` };
  };
  return {
    analyze: vi.fn(async (s: string) => out(s)),
    analyzeWithInputs: vi.fn(async (s: string) => ({ output: out(s), fundamentals: { sicCode: map[s]?.sic ?? null }, sourceId: "fake" })),
  } as unknown as DecisionService;
}

/** Stateful paper-like broker so approvals change the book. */
function fakeBroker(positions: Position[] = [], cash = 100_000) {
  const state = { cash, positions: [...positions] };
  const placeOrder = vi.fn(async (a: { side: string; symbol: string; qtyOrNotional: string; limitPrice: string; idempotencyKey: string }): Promise<OrderResult> => {
    const qty = Number(a.qtyOrNotional);
    const px = Number(a.limitPrice);
    if (a.side === "buy") {
      state.cash -= qty * px;
      state.positions.push({ symbol: a.symbol, qty, avgEntryPrice: px, marketValue: qty * px, unrealizedPl: 0 });
    } else {
      state.cash += qty * px;
      state.positions = state.positions.filter((p) => p.symbol !== a.symbol);
    }
    return { brokerOrderId: `o-${a.symbol}`, clientOrderId: a.idempotencyKey, status: "filled", filledQty: qty, filledAvgPrice: px };
  });
  return {
    id: "paper",
    placeOrder,
    getPositions: async () => state.positions,
    getCash: async () => state.cash,
    state,
  } as unknown as IBroker & { placeOrder: ReturnType<typeof vi.fn>; state: typeof state };
}

const marketData: MarketDataAdapter = { getBars: async () => [], getLatestPrice: async () => 10 };
const pos = (symbol: string, qty: number): Position => ({ symbol, qty, avgEntryPrice: 10, marketValue: qty * 10, unrealizedPl: 0 });

const ENV = ["RUNTIME_MODE", "RUNTIME_HALT", "RUNTIME_EXECUTION", "LIVE_TRADING_ENABLED", "KYC_PROVIDER", "AGENT_SCHEDULE", "AGENT_SCHEDULE_AUTO_EXECUTE", "RESEARCH_UNIVERSE"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

async function verified(userId = "u1") {
  const suitability = new SuitabilityService();
  const kyc = new KycService();
  process.env.KYC_PROVIDER = "mock";
  await kyc.start(userId);
  suitability.assess({ userId, objectives: "growth", riskTolerance: "medium", capacityForLoss: "medium", knowledgeExperience: "informed" });
  return { suitability, kyc };
}

/** Lynch picks only (the core ETF proposal filtered out). */
const picks = (run: { proposals: Array<{ role?: string }> }) => run.proposals.filter((p) => p.role !== "core");

const agent = (d: DecisionService, b: IBroker, extra: { suitability?: SuitabilityService; kyc?: KycService } = {}) =>
  new AgentService(d, b, marketData, new InMemoryAgentRunStore(), extra.suitability, extra.kyc);

describe("AgentService planning", () => {
  it("plans without placing orders, sizes buys like the backtest, and stores the run", async () => {
    const broker = fakeBroker();
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 }, BBB: { verdict: "hold", convictionScore: 50 } }), broker);
    const run = await svc.plan({ universe: ["aaa", "bbb", "ccc"], satellitePct: 100 });
    expect(broker.placeOrder).not.toHaveBeenCalled();
    expect(run.status).toBe("planned");
    expect(run.unavailable).toEqual(["CCC"]);
    const buy = run.proposals.find((p) => p.symbol === "AAA")!;
    // One candidate: equal weight = whole book, clamped to the 10% position cap.
    expect(buy).toMatchObject({ side: "buy", status: "proposed", qty: 1000, notional: 10_000, limitedBy: "position cap or cash floor", decisionHash: "h-AAA" });
    expect((await svc.listRuns()).map((r) => r.id)).toEqual([run.id]);
  });

  it("screens held names outside the universe so they can be sold", async () => {
    const svc = agent(fakeDecisions({ OLD: { verdict: "avoid", convictionScore: 20 } }), fakeBroker([pos("OLD", 5)]));
    const run = await svc.plan({ universe: ["NEW"] });
    expect(run.universe).toEqual(["NEW", "OLD"]);
    expect(picks(run)).toEqual([expect.objectContaining({ side: "sell", symbol: "OLD", qty: 5, status: "proposed" })]);
  });

  it("applies the 30% sector cap across buys", async () => {
    const map = Object.fromEntries(["A", "B", "C", "D"].map((s, i) => [s, { verdict: "buy" as Verdict, convictionScore: 90 - i, sic: "7372" }]));
    const run = await agent(fakeDecisions(map), fakeBroker()).plan({ universe: ["A", "B", "C", "D"], satellitePct: 100 });
    const placed = picks(run).filter((p) => (p as { status: string }).status === "proposed").reduce((t, p) => t + (p as { notional: number }).notional, 0);
    expect(placed).toBeLessThanOrEqual(30_000);
    expect(picks(run).at(-1)).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/sector already at the 30% cap/) });
  });
});

describe("AgentService approval", () => {
  it("refuses approval in RESEARCH_ONLY mode", async () => {
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), fakeBroker(), await verified());
    const run = await svc.plan({ universe: ["AAA"] });
    await expect(svc.approve(run.id, { proposalIds: [run.proposals[0]!.id], userId: "u1" })).rejects.toThrow(/RESEARCH_ONLY/);
  });

  it("requires KYC and suitability for the approving user", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), fakeBroker(), await verified("u1"));
    const run = await svc.plan({ universe: ["AAA"] });
    await expect(svc.approve(run.id, { proposalIds: [run.proposals[0]!.id], userId: "stranger" })).rejects.toThrow(/KYC/);
  });

  it("places only the approved proposals, sells first, with a per-run idempotency key", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const broker = fakeBroker([pos("OLD", 5)]);
    const svc = agent(
      fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 }, BBB: { verdict: "buy", convictionScore: 80 }, OLD: { verdict: "sell", convictionScore: 10 } }),
      broker,
      await verified(),
    );
    const run = await svc.plan({ universe: ["AAA", "BBB"] });
    const ids = run.proposals.filter((p) => p.symbol !== "BBB" && p.role !== "core").map((p) => p.id);
    const after = await svc.approve(run.id, { proposalIds: ids, userId: "u1" });
    const calls = broker.placeOrder.mock.calls.map((c) => c[0] as { side: string; symbol: string; idempotencyKey: string });
    expect(calls.map((c) => `${c.side}:${c.symbol}`)).toEqual(["sell:OLD", "buy:AAA"]);
    expect(calls[1]!.idempotencyKey).toBe(`agent:${run.id}:${run.proposals.find((p) => p.symbol === "AAA")!.id}`);
    expect(after.status).toBe("executed");
    expect(after.proposals.find((p) => p.symbol === "BBB")!.status).toBe("proposed");
    expect(after.proposals.find((p) => p.symbol === "AAA")).toMatchObject({ status: "placed", decidedBy: "user:u1", orderStatus: "filled" });
  });

  it("shrinks a buy to today's cap when the price rose after planning (instead of refusing it)", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    let px = 10;
    const md: MarketDataAdapter = { getBars: async () => [], getLatestPrice: async () => px };
    const broker = fakeBroker();
    const v = await verified();
    const svc = new AgentService(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker, md, new InMemoryAgentRunStore(), v.suitability, v.kyc);
    const run = await svc.plan({ universe: ["AAA"], satellitePct: 100 }); // 1000 shares = exactly the 10% cap
    px = 10.5;
    const after = await svc.approve(run.id, { proposalIds: [run.proposals[0]!.id], userId: "u1" });
    const p = after.proposals[0]!;
    expect(p.status).toBe("placed");
    expect(p.notional).toBeLessThanOrEqual(10_000 + 1e-6);
    expect(p.qty).toBeLessThan(1000);
    expect(p.limitedBy).toMatch(/at approval/);
  });

  it("re-checks limits at approval time against the live book", async () => {
    process.env.RUNTIME_MODE = "ADVISORY";
    const broker = fakeBroker();
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker, await verified());
    const run = await svc.plan({ universe: ["AAA"] }); // $10,000 against a $100,000 book
    broker.state.cash = 5_000; // the book shrank after planning
    const after = await svc.approve(run.id, { proposalIds: [run.proposals[0]!.id], userId: "u1" });
    expect(after.proposals[0]!.status).toBe("placed");
    expect(after.proposals[0]!.notional).toBeLessThanOrEqual(500 + 1e-6); // 10% of $5,000
    broker.state.cash = 0;
    const run2 = await svc.plan({ universe: ["AAA"] });
    expect(run2.proposals.every((p) => p.status !== "proposed")).toBe(true); // nothing fits, nothing proposed
  });

  it("RUNTIME_HALT blocks approval", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    process.env.RUNTIME_HALT = "true";
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), fakeBroker(), await verified());
    const run = await svc.plan({ universe: ["AAA"] });
    await expect(svc.approve(run.id, { proposalIds: [run.proposals[0]!.id], userId: "u1" })).rejects.toThrow(/halted/);
  });
});

describe("AgentService autonomous run", () => {
  it("does not execute in RESEARCH_ONLY (default) and records the run as blocked", async () => {
    const broker = fakeBroker();
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker);
    const out = await svc.run({ universe: ["aaa"] });
    expect(out.executed).toBe(false);
    expect(out.reason).toMatch(/blocked in RESEARCH_ONLY/);
    expect(out.plan.buys).toEqual(["AAA"]);
    expect(out.plan.core).toMatchObject({ symbol: "SPY", side: "buy" });
    expect(out.run.status).toBe("blocked");
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it("honours an explicit dryRun even when execution is permitted", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    const broker = fakeBroker();
    const out = await agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker).run({ universe: ["AAA"], dryRun: true });
    expect(out.executed).toBe(false);
    expect(out.reason).toMatch(/dryRun requested/);
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it("executes sells before buys in DISCRETIONARY mode", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    const broker = fakeBroker([pos("BBB", 5)]);
    const out = await agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 }, BBB: { verdict: "sell", convictionScore: 10 } }), broker).run({
      universe: ["AAA", "BBB"],
      satellitePct: 100,
    });
    expect(out.executed).toBe(true);
    // Sells, then picks, then the core with what is left.
    expect(broker.placeOrder.mock.calls.map((c) => `${(c[0] as { side: string }).side}:${(c[0] as { symbol: string }).symbol}`)).toEqual(["sell:BBB", "buy:AAA", "buy:SPY"]);
    expect(out.orders.slice(0, 2)).toEqual([
      { symbol: "BBB", side: "sell", qty: 5, status: "filled" },
      { symbol: "AAA", side: "buy", qty: 1000.5, status: "filled" },
    ]);
  });

  it("two runs can buy the same name (keys differ per run)", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    const broker = fakeBroker();
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker);
    await svc.run({ universe: ["AAA"] });
    broker.state.positions = []; // sold in between
    await svc.run({ universe: ["AAA"] });
    const keys = broker.placeOrder.mock.calls
      .filter((c) => (c[0] as { symbol: string }).symbol === "AAA")
      .map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("AgentService core + satellite", () => {
  it("caps the picks at the satellite share and puts the rest in the SPY core", async () => {
    // $100k, default 30% satellite: AAA's 10% cap applies WITHIN the $30k satellite -> $3,000.
    // Core target = 100k - 3k picks - 2k cash floor = $95k of SPY at $10.
    const run = await agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), fakeBroker()).plan({ universe: ["AAA"] });
    expect(picks(run)).toEqual([expect.objectContaining({ symbol: "AAA", notional: 3_000 })]);
    const core = run.proposals.find((p) => p.role === "core")!;
    expect(core).toMatchObject({ symbol: "SPY", side: "buy", qty: 9_500, verdict: "core" });
    expect(run.allocation).toMatchObject({ coreSymbol: "SPY", satellitePct: 30, totalEquity: 100_000, satelliteBudget: 30_000, coreTarget: 95_000 });
  });

  it("never screens or sells the core as a stock pick, and leaves it alone inside the band", async () => {
    const d = fakeDecisions({ AAA: { verdict: "hold", convictionScore: 60 } });
    // Book already on target: $30k picks, $68k SPY, $2k cash.
    const run = await agent(d, fakeBroker([pos("AAA", 3_000), pos("SPY", 6_800)], 2_000)).plan({ universe: ["AAA"] });
    expect(run.universe).toEqual(["AAA"]);
    expect(d.analyzeWithInputs).not.toHaveBeenCalledWith("SPY", expect.anything());
    expect(run.proposals).toEqual([]);
  });

  it("sells core to fund picks, and executes it before the pick buys", async () => {
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    const broker = fakeBroker([pos("SPY", 9_800)], 2_000); // fully in the core
    const out = await agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), broker).run({ universe: ["AAA"] });
    expect(broker.placeOrder.mock.calls.map((c) => `${(c[0] as { side: string }).side}:${(c[0] as { symbol: string }).symbol}`)).toEqual(["sell:SPY", "buy:AAA"]);
    expect(out.plan.core).toMatchObject({ symbol: "SPY", side: "sell" });
  });

  it("rejects a satellite share outside 0-100", async () => {
    await expect(agent(fakeDecisions({}), fakeBroker()).plan({ universe: ["AAA"], satellitePct: 150 })).rejects.toThrow(/between 0 and 100/);
  });
});

describe("AgentScheduler", () => {
  it("is off by default and plans only unless auto-execute is on and permitted", async () => {
    const svc = agent(fakeDecisions({}), fakeBroker());
    const s = new AgentScheduler(svc);
    expect(s.state()).toMatchObject({ cadence: "off", nextRunAt: null, willExecute: false });
    process.env.AGENT_SCHEDULE = "weekly";
    process.env.AGENT_SCHEDULE_AUTO_EXECUTE = "true";
    expect(s.state().willExecute).toBe(false); // RESEARCH_ONLY
    process.env.RUNTIME_MODE = "DISCRETIONARY";
    expect(s.state().willExecute).toBe(true);
  });

  it("a scheduled fire stores a schedule-triggered run", async () => {
    process.env.AGENT_SCHEDULE = "daily";
    const svc = agent(fakeDecisions({ AAA: { verdict: "buy", convictionScore: 90 } }), fakeBroker());
    const s = new AgentScheduler(svc);
    await s.fire();
    s.onModuleDestroy();
    const [run] = await svc.listRuns();
    expect(run).toMatchObject({ trigger: "schedule", status: "blocked" });
    expect(s.state().lastRun).toMatchObject({ runId: run!.id });
  });
});
