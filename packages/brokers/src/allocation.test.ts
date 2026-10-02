import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOCATION, allocationFromConfig, planCore, satelliteCash } from "./allocation.js";

const policy = DEFAULT_ALLOCATION; // SPY, 30% satellite, 2% floor, 1% band

describe("core + satellite allocation", () => {
  it("gives new picks the satellite budget minus what kept picks are worth", () => {
    expect(satelliteCash(100_000, 10_000, policy)).toBe(20_000);
    // Picks that grew past the budget are not trimmed: no new money, never negative.
    expect(satelliteCash(100_000, 45_000, policy)).toBe(0);
  });

  it("puts everything but the picks and the cash floor in the core", () => {
    // Fresh $100k account, $30k of picks planned: core target 100k - 30k - 2k = 68k.
    const t = planCore({ totalEquity: 100_000, coreValue: 0, picksValueAfter: 30_000, price: 500, policy });
    expect(t).toEqual({ side: "buy", qty: 136, notional: 68_000, target: 68_000 });
  });

  it("sells core to fund picks when the core is over target", () => {
    const t = planCore({ totalEquity: 100_000, coreValue: 90_000, picksValueAfter: 30_000, price: 500, policy });
    expect(t?.side).toBe("sell");
    expect(t?.notional).toBe(22_000);
  });

  it("does not churn the core inside the band", () => {
    expect(planCore({ totalEquity: 100_000, coreValue: 67_500, picksValueAfter: 30_000, price: 500, policy })).toBeNull();
  });

  it("rounds to whole shares when the broker needs them", () => {
    expect(planCore({ totalEquity: 100_000, coreValue: 0, picksValueAfter: 30_000, price: 700, policy, wholeShares: true })?.qty).toBe(97);
  });

  it("reads the config block, lets a run override the satellite share, and rejects nonsense", () => {
    expect(allocationFromConfig({ core_symbol: "voo", satellite_pct_default: 20 })).toMatchObject({ coreSymbol: "VOO", satellitePct: 20 });
    expect(allocationFromConfig(undefined, 100).satellitePct).toBe(100);
    expect(() => allocationFromConfig(undefined, 150)).toThrow(/between 0 and 100/);
  });
});
