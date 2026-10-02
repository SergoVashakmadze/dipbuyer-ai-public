import { describe, expect, it } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import { InMemoryFundamentals, InMemoryMarketData, type PriceBar } from "@dipbuyer/data";
import { hashDecision } from "@dipbuyer/chain";
import { runBacktest } from "./run.js";
import type { BacktestParams } from "./index.js";

const fund = (asOf: string): Fundamentals =>
  ({ symbol: "AAA", asOf, peRatio: 12, epsGrowthPct: 25, epsGrowthHistoryPct: [22, 24, 25], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: 30, inventoryGrowthPct: 10, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: 18, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null }) as Fundamentals;

const bar = (ts: string, close: number): PriceBar => ({ symbol: "AAA", ts, open: close, high: close, low: close, close, volume: 1_000_000 });

const params: BacktestParams = {
  universe: ["AAA"],
  from: "2026-01-01T00:00:00Z",
  to: "2026-03-01T00:00:00Z",
  rebalance: "monthly",
  initialCapital: 10_000,
  frictions: { commissionBps: 0, slippageBps: 20, spreadBps: 10 },
  benchmark: "^GSPC",
  seed: 1,
};

describe("backtest audit trail", () => {
  it("emits an audit-ready, hashable DecisionRecord per decision", async () => {
    const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const fundamentals = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z")]]]));
    const marketData = new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 12)]]]));

    const result = await runBacktest(params, { fundamentals, marketData, schedule });

    expect(result.decisionRecords.length).toBeGreaterThan(0);
    for (const rec of result.decisionRecords) {
      expect(rec.verdict).not.toBe("abstain");
      expect(rec.model.strategyConfigHash).toBeTruthy();
      // The conviction score must be reconstructible — checklist present.
      expect(rec.criteria.length).toBeGreaterThan(0);
      // Each record produces a stable 64-char audit hash, ready to anchor on Algorand.
      expect(hashDecision(rec)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("frictions reduce realised performance vs frictionless", async () => {
    const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const mk = () => ({
      fundamentals: new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z")]]])),
      marketData: new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 12)]]])),
      schedule,
    });
    const withFric = await runBacktest(params, mk());
    const noFric = await runBacktest({ ...params, frictions: { commissionBps: 0, slippageBps: 0, spreadBps: 0 } }, mk());
    expect(withFric.equityCurve.at(-1)!.value).toBeLessThanOrEqual(noFric.equityCurve.at(-1)!.value);
  });
});
