import { describe, expect, it, vi } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import { DecisionService, InMemoryDecisionStore } from "@dipbuyer/agent";
import { InMemoryFundamentals, isSyntheticSource, type MarketDataAdapter, type PriceBar } from "@dipbuyer/data";
import { DemoMarketData } from "../orders/market-data.provider.js";
import { ResearchService } from "./research.service.js";
import { DEFAULT_RESEARCH_UNIVERSE, researchUniverse } from "./universe.js";

const NOW = new Date("2026-09-15T00:00:00Z");

const f = (symbol: string, over: Partial<Fundamentals> = {}): Fundamentals =>
  ({ symbol, asOf: "2026-06-30T00:00:00Z", peRatio: 20, epsGrowthPct: 20, epsGrowthHistoryPct: [18, 19, 20], dividendYieldPct: 2, payoutRatio: 0.3, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: 15, inventoryGrowthPct: 5, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: 18, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null, ...over }) as Fundamentals;

/** Flat at 200 for most of the year, then down to 150: a 25% dip. */
function dipBars(symbol: string): PriceBar[] {
  return Array.from({ length: 380 }, (_, i) => {
    const ts = new Date(NOW.getTime() - (379 - i) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const close = i < 330 ? 200 : 150;
    return { symbol, ts, open: close, high: close, low: close, close, volume: 1 };
  });
}

function setup(market?: MarketDataAdapter) {
  const store = new InMemoryDecisionStore();
  const decisions = new DecisionService({
    fundamentals: new InMemoryFundamentals(new Map([["AAA", [f("AAA")]], ["BBB", [f("BBB", { peRatio: 60 })]]])),
    store,
  });
  const md: MarketDataAdapter = market ?? {
    getBars: async (s) => dipBars(s),
    getLatestPrice: async () => 150,
  };
  const service = new ResearchService(decisions, md, {
    priceSourceId: "test-prices",
    universe: () => ["AAA", "BBB", "MISSING"],
    now: () => NOW,
  });
  return { service, store };
}

describe("ResearchService.view", () => {
  it("returns the engine's decision with price context, valuation and provenance", async () => {
    const { service, store } = setup();
    const v = await service.view("AAA");
    expect(v.decision.record.symbol).toBe("AAA");
    expect(v.price?.price).toBe(150);
    expect(v.price?.drawdown).toBeCloseTo(0.25, 10);
    // EPS = 150 / 20 = 7.5; Lynch fair value = 7.5 × (20 + 2) = 165
    expect(v.valuation.lynchFairValue).toBeCloseTo(165, 10);
    expect(v.provenance).toEqual([
      { field: "fundamentals", source: "in-memory-demo", asOf: "2026-06-30T00:00:00Z" },
      { field: "price", source: "test-prices", asOf: v.price!.asOf },
    ]);
    expect(await store.recent()).toHaveLength(1);
  });

  it("still returns the verdict when price history fails", async () => {
    const { service } = setup({
      getBars: async () => {
        throw new Error("alpaca bars AAA: HTTP 403");
      },
      getLatestPrice: async () => 0,
    });
    const v = await service.view("AAA");
    expect(v.decision.record.verdict).toBeTruthy();
    expect(v.price).toBeNull();
    expect(v.valuation.intrinsicValue).toBeNull();
    expect(v.provenance[1]).toEqual({ field: "price", source: "unavailable", asOf: null });
  });
});

describe("ResearchService.screener", () => {
  it("lists unavailable names instead of silently dropping them, and does not write audit records", async () => {
    const { service, store } = setup();
    const r = await service.screener();
    expect(r.rows.map((x) => x.symbol)).toEqual(["AAA", "BBB"]);
    expect(r.unavailable).toEqual(["MISSING"]);
    expect(await store.recent()).toHaveLength(0);
    const bbb = r.rows.find((x) => x.symbol === "BBB")!;
    expect(bbb.verdict).toBe("sell"); // PEGY 60/22 > 2
  });

  it("serves repeat calls from cache within the TTL", async () => {
    const getBars = vi.fn(async (s: string) => dipBars(s));
    const { service } = setup({ getBars, getLatestPrice: async () => 150 });
    await service.screener();
    await service.screener();
    expect(getBars).toHaveBeenCalledTimes(3);
  });
});

describe("demo market data", () => {
  it("is flagged synthetic and ends exactly at its demo price", async () => {
    const demo = new DemoMarketData();
    expect(isSyntheticSource(demo.sourceId)).toBe(true);
    const bars = await demo.getBars("AAPL", "2025-09-01T00:00:00Z", "2026-09-15T00:00:00Z");
    expect(bars.length).toBeGreaterThan(300);
    expect(bars.at(-1)!.close).toBe(190);
    expect(bars.at(-1)!.ts).toBe("2026-09-15T00:00:00Z");
    expect(await demo.getBars("AAPL", "2025-09-01T00:00:00Z", "2026-09-15T00:00:00Z")).toEqual(bars);
  });
});

describe("research universe", () => {
  it("uses the curated default unless RESEARCH_UNIVERSE is set, and validates tickers", () => {
    const saved = process.env.RESEARCH_UNIVERSE;
    try {
      delete process.env.RESEARCH_UNIVERSE;
      expect(researchUniverse()).toBe(DEFAULT_RESEARCH_UNIVERSE);
      process.env.RESEARCH_UNIVERSE = "aapl, msft,,<script>,AAPL";
      expect(researchUniverse()).toEqual(["AAPL", "MSFT"]);
    } finally {
      if (saved === undefined) delete process.env.RESEARCH_UNIVERSE;
      else process.env.RESEARCH_UNIVERSE = saved;
    }
  });
});

describe("unknown symbol detection", () => {
  it("maps each adapter's 'nothing for this ticker' error, but not transport failures", async () => {
    const { isUnknownSymbol } = await import("./research.controller.js");
    expect(isUnknownSymbol(new Error("No fundamentals for ZZZZ"))).toBe(true);
    expect(isUnknownSymbol(new Error("sec-edgar: no CIK for ZZZZ (US filers only)"))).toBe(true);
    expect(isUnknownSymbol(new Error("financialdatasets ZZZZ: no metrics"))).toBe(true);
    expect(isUnknownSymbol(new Error("financialdatasets /financial-metrics: HTTP 404"))).toBe(true);
    expect(isUnknownSymbol(new Error("financialdatasets /financial-metrics: HTTP 402"))).toBe(false);
    expect(isUnknownSymbol(new Error("sec-edgar companyfacts AAPL: HTTP 503"))).toBe(false);
  });
});
