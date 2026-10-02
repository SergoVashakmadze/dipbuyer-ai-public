import { describe, expect, it } from "vitest";
import { piotroskiFScore, type PiotroskiYear } from "./piotroski.js";

const year = (o: Partial<PiotroskiYear>): PiotroskiYear => ({
  netIncome: 100, cfo: 150, assets: 1000, longTermDebt: 200, currentAssets: 400, currentLiabilities: 200,
  sharesDiluted: 100, revenue: 1000, grossProfit: 400, ...o,
});

describe("Piotroski F_SCORE", () => {
  it("scores a firm improving on every dimension 9/9 (hand-checked)", () => {
    const t = year({ netIncome: 120, cfo: 180, assets: 1000, longTermDebt: 150, currentAssets: 450, grossProfit: 460, revenue: 1100 }); // margin 41.8% vs 40%
    const t1 = year({ netIncome: 90, assets: 1000, longTermDebt: 200 });
    const r = piotroskiFScore(t, t1, { assets: 1000 });
    expect(r.signals).toEqual({ roa: 1, cfo: 1, deltaRoa: 1, accrual: 1, deltaLever: 1, deltaLiquid: 1, eqOffer: 1, deltaMargin: 1, deltaTurn: 1 });
    expect(r.score).toBe(9);
    expect(r.computable).toBe(9);
  });

  it("scores a deteriorating, diluting, accrual-heavy firm near zero", () => {
    const t = year({ netIncome: -50, cfo: -80, longTermDebt: 400, currentAssets: 300, sharesDiluted: 130, grossProfit: 300, revenue: 900 });
    const t1 = year({ netIncome: 40 });
    const r = piotroskiFScore(t, t1, { assets: 1000 });
    expect(r.signals.roa).toBe(0);
    expect(r.signals.accrual).toBe(0); // CFO/A (-0.08) is not above ROA (-0.05)
    expect(r.signals.eqOffer).toBe(0); // +30% shares
    expect(r.score).toBe(0);
  });

  it("does not read a stock split as an equity offering", () => {
    const r = piotroskiFScore(year({ sharesDiluted: 1000 }), year({ sharesDiluted: 100 }), { assets: 1000 });
    expect(r.signals.eqOffer).toBe(1);
  });

  it("marks signals with missing inputs as null and counts only computable ones", () => {
    const r = piotroskiFScore(year({ grossProfit: null }), year({}), { assets: null });
    expect(r.signals.deltaMargin).toBeNull();
    expect(r.signals.deltaRoa).toBeNull(); // needs t-2 assets
    expect(r.signals.deltaTurn).toBeNull();
    expect(r.computable).toBe(5);
  });
});
