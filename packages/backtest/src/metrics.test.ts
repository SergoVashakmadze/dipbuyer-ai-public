import { describe, expect, it } from "vitest";
import { computeMetrics, maxDrawdownPct, periodReturns } from "./metrics.js";

describe("metrics", () => {
  it("periodReturns computes simple returns", () => {
    expect(periodReturns([100, 110, 99])).toEqual([0.1, expect.closeTo(-0.1, 5)]);
  });

  it("maxDrawdownPct finds the worst peak-to-trough", () => {
    expect(maxDrawdownPct([100, 120, 60, 90])).toBeCloseTo(50, 5); // 120 -> 60
  });

  it("flat equity yields zero return and zero drawdown", () => {
    const m = computeMetrics([100, 100, 100], { periodsPerYear: 12 });
    expect(m.totalReturnPct).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.sharpe).toBe(0);
  });

  it("rising equity yields positive total return", () => {
    const m = computeMetrics([100, 110, 121], { periodsPerYear: 12 });
    expect(m.totalReturnPct).toBeCloseTo(21, 5);
    expect(m.winRatePct).toBe(100);
  });
});
