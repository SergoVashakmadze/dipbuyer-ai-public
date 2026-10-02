import { describe, expect, it } from "vitest";
import { guardrailsFromConfig, sizeBuys } from "./sizing.js";

const g = { maxPositions: 40, maxPositionPct: 10, minCashFloorPct: 2, maxSectorPct: 30 };

describe("sizeBuys (live agent = backtest sizing)", () => {
  it("equal-weights across held + candidates, highest conviction first", () => {
    const out = sizeBuys({
      candidates: [
        { symbol: "LOW", price: 10, convictionScore: 71, sector: "tech" },
        { symbol: "HIGH", price: 20, convictionScore: 95, sector: "health" },
      ],
      held: [{ symbol: "OLD", value: 20_000, sector: "energy" }],
      cash: 80_000,
      guardrails: { ...g, maxPositionPct: 100, maxSectorPct: 100 },
    });
    expect(out.equity).toBe(100_000);
    expect(out.intendedPositions).toBe(3);
    expect(out.buys.map((b) => b.symbol)).toEqual(["HIGH", "LOW"]);
    expect(out.buys[0]!.notional).toBeCloseTo(100_000 / 3, 0);
  });

  it("clamps each buy to the 10% position cap", () => {
    const out = sizeBuys({ candidates: [{ symbol: "A", price: 10, convictionScore: 90, sector: null }], held: [], cash: 100_000, guardrails: g });
    expect(out.buys[0]!.notional).toBeCloseTo(10_000, 0);
    expect(out.buys[0]!.limitedBy).toBe("position cap or cash floor");
  });

  it("stops a sector at 30% and says why", () => {
    const candidates = ["A", "B", "C", "D"].map((s, i) => ({ symbol: s, price: 1, convictionScore: 90 - i, sector: "tech" }));
    const out = sizeBuys({ candidates, held: [], cash: 100_000, guardrails: g });
    const bought = out.buys.filter((b) => b.qty > 0).reduce((t, b) => t + b.notional, 0);
    expect(bought).toBeLessThanOrEqual(30_000 + 1e-6);
    expect(out.buys.at(-1)!.skipReason).toMatch(/tech sector already at the 30% cap/);
  });

  it("respects max positions and never re-buys a held name", () => {
    const out = sizeBuys({
      candidates: [
        { symbol: "HELD", price: 10, convictionScore: 99, sector: null },
        { symbol: "NEW", price: 10, convictionScore: 90, sector: null },
      ],
      held: [{ symbol: "HELD", value: 5_000, sector: null }],
      cash: 50_000,
      guardrails: { ...g, maxPositions: 1 },
    });
    expect(out.buys).toEqual([expect.objectContaining({ symbol: "NEW", qty: 0, skipReason: expect.stringMatching(/maximum 1 positions/) })]);
  });

  it("uses whole shares when asked and explains a sub-share target", () => {
    const out = sizeBuys({ candidates: [{ symbol: "BRK", price: 700_000, convictionScore: 90, sector: null }], held: [], cash: 100_000, guardrails: g, wholeShares: true });
    expect(out.buys[0]).toMatchObject({ qty: 0, skipReason: "target is less than one whole share" });
  });

  it("reads guardrails from the strategy config", () => {
    expect(guardrailsFromConfig({ max_positions: 20, max_position_pct_of_portfolio: 5, min_cash_floor_pct: 3, max_sector_pct_of_portfolio: 25 })).toEqual({
      maxPositions: 20, maxPositionPct: 5, minCashFloorPct: 3, maxSectorPct: 25,
    });
  });
});
