import { describe, expect, it } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import {
  grahamValue,
  impliedEps,
  lynchFairValue,
  lynchRatio,
  priceContext,
  qualityProfile,
  scale,
  valuation,
} from "./valuation.js";

function base(overrides: Partial<Fundamentals> = {}): Fundamentals {
  return {
    symbol: "TEST",
    asOf: "2026-01-01T00:00:00Z",
    peRatio: 20,
    epsGrowthPct: 20,
    epsGrowthHistoryPct: [18, 19, -2, 21],
    dividendYieldPct: 2,
    payoutRatio: 0.3,
    debtToEquity: 0.4,
    netCashPerShare: 5,
    roePct: 22,
    currentRatio: 1.8,
    freeCashFlow: 1_000_000,
    revenueGrowthPct: 12,
    inventoryGrowthPct: 5,
    marketCapUsd: 2e9,
    salesUsd: 1.5e9,
    institutionalOwnershipPct: 30,
    institutionalOwnershipMedianPct: 50,
    insiderNetBuying: true,
    fiveYearAvgPe: 18,
    earningsCyclicality: "low",
    distressed: false,
    hiddenAssetValueToMarketCap: null,
    ...overrides,
  };
}

describe("fair value models", () => {
  it("Lynch's own example: 12% growth + 3% yield at P/E 10 is a ratio of 1.5", () => {
    expect(lynchRatio({ peRatio: 10, epsGrowthPct: 12, dividendYieldPct: 3 })).toBeCloseTo(1.5, 10);
  });

  it("implied EPS is price / P/E and undefined for losses", () => {
    expect(impliedEps(100, 20)).toBe(5);
    expect(impliedEps(100, -4)).toBeNull();
    expect(impliedEps(null, 20)).toBeNull();
  });

  it("Lynch fair value = EPS × (growth + yield), growth capped at 25", () => {
    expect(lynchFairValue(5, 20, 2)).toBeCloseTo(110, 10);
    expect(lynchFairValue(5, 60, 0)).toBeCloseTo(125, 10);
    expect(lynchFairValue(5, 0, 2)).toBeNull();
    expect(lynchFairValue(-1, 20, 2)).toBeNull();
  });

  it("Graham revised formula, hand-checked, with growth clamped to [0, 15]", () => {
    expect(grahamValue(5, 10, 4.4)).toBeCloseTo(142.5, 10); // 5 × 28.5
    expect(grahamValue(5, 40, 4.4)).toBeCloseTo(192.5, 10); // 5 × 38.5
    expect(grahamValue(5, -10, 4.4)).toBeCloseTo(42.5, 10); // 5 × 8.5
    expect(grahamValue(0, 10)).toBeNull();
  });

  it("blends the models that apply and reports upside against price", () => {
    const v = valuation(base(), 100, 4.4);
    expect(v.eps).toBe(5);
    expect(v.lynchFairValue).toBeCloseTo(110, 10);
    expect(v.grahamValue).toBeCloseTo(192.5, 10);
    expect(v.intrinsicValue).toBeCloseTo(151.25, 10);
    expect(v.upside).toBeCloseTo(0.5125, 10);
  });

  it("gives no intrinsic value for a loss-making company rather than a negative price", () => {
    const v = valuation(base({ peRatio: null }), 100);
    expect(v.intrinsicValue).toBeNull();
    expect(v.upside).toBeNull();
  });
});

describe("price context", () => {
  const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString();

  it("measures drawdown from the 52-week high and position in the range", () => {
    // Rises 100 -> 200 over 200 days, then falls to 150.
    const bars = [
      ...Array.from({ length: 201 }, (_, i) => ({ ts: day(i), close: 100 + i / 2 })),
      ...Array.from({ length: 100 }, (_, i) => ({ ts: day(201 + i), close: 200 - (i + 1) / 2 })),
    ];
    const p = priceContext(bars)!;
    expect(p.price).toBeCloseTo(150, 10);
    expect(p.high52w).toBeCloseTo(200, 10);
    expect(p.low52w).toBeCloseTo(100, 10);
    expect(p.drawdown).toBeCloseTo(0.25, 10);
    expect(p.rangePosition).toBeCloseTo(0.5, 10);
  });

  it("returns null for lookbacks longer than the history instead of guessing", () => {
    const bars = Array.from({ length: 40 }, (_, i) => ({ ts: day(i), close: 100 + i }));
    const p = priceContext(bars)!;
    expect(p.returns["1M"]).not.toBeNull();
    expect(p.returns["3M"]).toBeNull();
    expect(p.returns["1Y"]).toBeNull();
  });

  it("is null with no usable bars", () => {
    expect(priceContext([])).toBeNull();
    expect(priceContext([{ ts: day(0), close: 0 }])).toBeNull();
  });
});

describe("quality profile", () => {
  it("scale handles inverted ranges and clamps", () => {
    expect(scale(1, 2, 0)).toBeCloseTo(5, 10);
    expect(scale(-1, 2, 0)).toBe(10);
    expect(scale(null, 0, 1)).toBeNull();
  });

  it("treats negative equity as unknown health, not a pristine balance sheet", () => {
    const negative = qualityProfile(base({ debtToEquity: -20, currentRatio: null, netCashPerShare: null }), null);
    expect(negative.health).toBeNull();
  });

  it("needs at least three pillars for an overall rating", () => {
    const empty = qualityProfile(
      base({
        epsGrowthPct: null, epsGrowthHistoryPct: [], revenueGrowthPct: null, roePct: null, freeCashFlow: null,
        debtToEquity: null, currentRatio: null, netCashPerShare: null, distressed: null, payoutRatio: null,
        insiderNetBuying: null,
      }),
      null,
    );
    expect(empty.overall).toBeNull();
    const full = qualityProfile(base(), null);
    expect(full.overall).toBeGreaterThan(6);
    expect(full.overall).toBeLessThanOrEqual(10);
  });
});
