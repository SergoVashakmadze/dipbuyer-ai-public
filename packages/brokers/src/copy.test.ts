import { describe, expect, it } from "vitest";
import { planCopy, weightsOf } from "./copy.js";

const prices = { SPY: 500, NVDA: 100, KO: 50 };

describe("planCopy", () => {
  it("brings a cash account to the model's weights, sells first", () => {
    const { equity, trades } = planCopy({ weights: { SPY: 0.9, NVDA: 0.05 }, positions: [], cash: 100_000, prices });
    expect(equity).toBe(100_000);
    expect(trades.map((t) => [t.side, t.symbol, t.qty])).toEqual([
      ["buy", "SPY", 180],
      ["buy", "NVDA", 50],
    ]);
  });

  it("sells what the model no longer holds, but never the follower's own picks", () => {
    const { equity, trades } = planCopy({
      weights: { SPY: 1 },
      positions: [
        { symbol: "KO", qty: 100, selfQty: 100 }, // bought by the follower: untouched, not in the equity base
        { symbol: "NVDA", qty: 10 }, // agent pick the model dropped: sold
      ],
      cash: 9_000,
      prices,
    });
    expect(equity).toBe(10_000);
    expect(trades.map((t) => [t.side, t.symbol, t.qty])).toEqual([
      ["sell", "NVDA", 10],
      ["buy", "SPY", 20],
    ]);
  });

  it("skips trades inside the band and anything it cannot price", () => {
    const { trades } = planCopy({ weights: { SPY: 0.5, XYZ: 0.2 }, positions: [{ symbol: "SPY", qty: 99.5 }], cash: 50_250, prices });
    expect(trades).toEqual([]); // SPY off by 0.25% (< 1% band), XYZ has no price
  });
});

describe("weightsOf", () => {
  it("measures each holding against total equity including cash", () => {
    expect(weightsOf([{ symbol: "SPY", qty: 18 }, { symbol: "NVDA", qty: 10 }], 0, prices)).toEqual({ SPY: 0.9, NVDA: 0.1 });
  });
});
