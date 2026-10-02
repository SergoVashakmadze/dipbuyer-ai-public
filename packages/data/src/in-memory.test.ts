import { describe, expect, it } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import { InMemoryFundamentals, InMemoryMarketData } from "./in-memory.js";
import type { PriceBar } from "./index.js";

const snap = (asOf: string, pe: number): Fundamentals =>
  ({ symbol: "AAA", asOf, peRatio: pe, epsGrowthPct: 20, epsGrowthHistoryPct: [], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: 22, inventoryGrowthPct: 10, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: 18, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null }) as Fundamentals;

describe("InMemoryFundamentals (point-in-time)", () => {
  const f = new InMemoryFundamentals(
    new Map([["AAA", [snap("2026-01-01T00:00:00Z", 10), snap("2026-04-01T00:00:00Z", 20)]]]),
  );

  it("returns the newest snapshot at or before the clock (NO look-ahead)", async () => {
    expect((await f.getFundamentals("AAA", "2026-02-01T00:00:00Z")).peRatio).toBe(10);
    expect((await f.getFundamentals("AAA", "2026-05-01T00:00:00Z")).peRatio).toBe(20);
  });

  it("does not leak a future snapshot", async () => {
    // As of Jan, the April snapshot must be invisible.
    expect((await f.getFundamentals("AAA", "2026-01-15T00:00:00Z")).asOf).toBe("2026-01-01T00:00:00Z");
  });

  it("throws when nothing is eligible yet", async () => {
    await expect(f.getFundamentals("AAA", "2025-01-01T00:00:00Z")).rejects.toThrow();
  });
});

describe("InMemoryMarketData (point-in-time)", () => {
  const bar = (ts: string, close: number): PriceBar => ({ symbol: "AAA", ts, open: close, high: close, low: close, close, volume: 1 });
  const m = new InMemoryMarketData(new Map([["AAA", [bar("2026-01-01T00:00:00Z", 5), bar("2026-02-01T00:00:00Z", 7)]]]));

  it("latest price respects the clock", async () => {
    expect(await m.getLatestPrice("AAA", "2026-01-15T00:00:00Z")).toBe(5);
    expect(await m.getLatestPrice("AAA", "2026-03-01T00:00:00Z")).toBe(7);
  });
});
