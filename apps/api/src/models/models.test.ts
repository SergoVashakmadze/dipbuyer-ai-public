import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAgentRunStore, type DecisionService } from "@dipbuyer/agent";
import type { IBroker, OrderResult, Position } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import { AgentService } from "../agent/agent.service.js";
import { LedgerStore } from "../orders/portfolio.store.js";
import { ModelBook, ModelsService } from "./models.js";

const PRICES: Record<string, number> = { SPY: 500, AAA: 100, KO: 50 };
const marketData: MarketDataAdapter = { getBars: async () => [], getLatestPrice: async (s: string) => PRICES[s] ?? 0 };

/** AAA rates a buy; everything else is unknown (screened out). */
const decisions = {
  analyze: vi.fn(),
  analyzeWithInputs: vi.fn(async (s: string) => {
    if (s !== "AAA") throw new Error(`no data for ${s}`);
    return { output: { record: { verdict: "buy", convictionScore: 90, lynchCategory: "stalwart" }, hash: "h" }, fundamentals: { sicCode: null }, sourceId: "fake" };
  }),
} as unknown as DecisionService;

function account(positions: Position[], cash: number) {
  return {
    id: "paper",
    placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "x", clientOrderId: "x", status: "filled" })),
    getPositions: async () => positions,
    getCash: async () => cash,
  } as unknown as IBroker;
}

beforeEach(() => {
  process.env.MODELS_DIR = ""; // in memory
  process.env.RESEARCH_UNIVERSE = "AAA";
});

describe("ModelsService", () => {
  it("rebalances a model on its own simulated book: picks within the satellite, the rest in SPY", async () => {
    const acct = account([], 100_000);
    const svc = new ModelsService(decisions, marketData, acct, new LedgerStore(), new AgentService(decisions, acct, marketData, new InMemoryAgentRunStore()));
    const v = await svc.rebalance("core-satellite");
    // $30k satellite, one pick capped at 10% of it = $3k of AAA; core = 100k - 3k - 2k floor = $95k of SPY.
    expect(v.holdings.map((h) => [h.symbol, Math.round(h.value)])).toEqual([
      ["SPY", 95_000],
      ["AAA", 3_000],
    ]);
    expect(v.holdings[0]!.role).toBe("core");
    expect(acct.placeOrder).not.toHaveBeenCalled(); // the investor's account is never touched by a model
    await expect(svc.rebalance("core-satellite")).rejects.toThrow(/at most once a day/);
  });

  it("copies a model into an account as a plan, leaving the investor's own picks alone", async () => {
    const acct = account([{ symbol: "KO", qty: 100, avgEntryPrice: 50, marketValue: 5_000, unrealizedPl: 0 }], 95_000);
    const ledger = new LedgerStore();
    await ledger.record({ id: "k", ts: "2026-09-18T10:00:00Z", userId: "u1", source: "self", symbol: "KO", side: "buy", qty: 100, price: 50, status: "filled" });
    const runs = new InMemoryAgentRunStore();
    const svc = new ModelsService(decisions, marketData, acct, ledger, new AgentService(decisions, acct, marketData, runs));
    await svc.rebalance("core-satellite");
    const plan = await svc.copyFor("u1", "core-satellite");
    expect(plan.trigger).toBe("copy");
    expect(plan.proposals.map((p) => [p.side, p.symbol, p.role])).toEqual([
      ["buy", "SPY", "core"],
      ["buy", "AAA", "satellite"],
    ]); // KO (the investor's own pick) is not sold
    expect(plan.proposals[0]!.notional).toBeCloseTo(0.95 * 95_000, -2); // weights apply to the $95k not in own picks
    expect((await runs.get(plan.id))?.status).toBe("planned"); // saved for approval on /agent
    expect(acct.placeOrder).not.toHaveBeenCalled();
  });

  it("refuses to run the model-only executor on a real account", async () => {
    const acct = account([], 1_000);
    const agent = new AgentService(decisions, acct, marketData, new InMemoryAgentRunStore());
    const run = await agent.plan({ universe: ["AAA"] });
    await expect(agent.executeSimulated(run.id, "x")).rejects.toThrow(/only for simulated/);
    expect(new ModelBook().simulated).toBe(true);
  });
});
