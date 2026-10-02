import { describe, expect, it } from "vitest";
import { planTrades } from "./planner.js";

describe("planTrades", () => {
  it("buys ranked buy candidates not already held", () => {
    const plan = planTrades(
      [
        { symbol: "AAA", verdict: "buy", convictionScore: 80 },
        { symbol: "BBB", verdict: "buy", convictionScore: 95 },
        { symbol: "CCC", verdict: "hold", convictionScore: 50 },
      ],
      [],
    );
    expect(plan.buys).toEqual(["BBB", "AAA"]); // highest conviction first
    expect(plan.sells).toEqual([]);
  });

  it("does not re-buy a name already held", () => {
    const plan = planTrades([{ symbol: "AAA", verdict: "buy", convictionScore: 80 }], [{ symbol: "AAA", qty: 5 }]);
    expect(plan.buys).toEqual([]);
  });

  it("divests held names now rated sell/avoid/trim", () => {
    const plan = planTrades(
      [
        { symbol: "AAA", verdict: "sell", convictionScore: 10 },
        { symbol: "BBB", verdict: "avoid", convictionScore: 20 },
        { symbol: "CCC", verdict: "hold", convictionScore: 60 },
      ],
      [
        { symbol: "AAA", qty: 5 },
        { symbol: "BBB", qty: 3 },
        { symbol: "CCC", qty: 2 },
      ],
    );
    expect(plan.sells.sort()).toEqual(["AAA", "BBB"]);
    expect(plan.sells).not.toContain("CCC"); // hold stays
  });

  it("ignores sell signals for names not held", () => {
    const plan = planTrades([{ symbol: "AAA", verdict: "sell", convictionScore: 10 }], []);
    expect(plan.sells).toEqual([]);
  });
});
