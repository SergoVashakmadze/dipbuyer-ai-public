import { describe, expect, it } from "vitest";
import { markPosition, portfolioValue } from "./valuation.js";

describe("valuation", () => {
  it("markPosition computes market value and unrealized P/L", () => {
    const v = markPosition({ symbol: "AAA", qty: 10, avgEntryPrice: 8 }, 12);
    expect(v.marketValue).toBe(120);
    expect(v.unrealizedPl).toBe(40); // (12-8)*10
  });

  it("markPosition handles a loss", () => {
    const v = markPosition({ symbol: "AAA", qty: 5, avgEntryPrice: 20 }, 15);
    expect(v.unrealizedPl).toBe(-25);
  });

  it("portfolioValue sums cash + position market values", () => {
    expect(
      portfolioValue(1000, [{ marketValue: 120 }, { marketValue: 380 }]),
    ).toBe(1500);
  });

  it("portfolioValue with no positions equals cash", () => {
    expect(portfolioValue(2500, [])).toBe(2500);
  });
});
