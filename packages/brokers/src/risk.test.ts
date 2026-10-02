import { describe, expect, it } from "vitest";
import { checkRisk, maxBuyNotional, sectorHeadroom, type RiskContext, type RiskParams } from "./risk.js";

const params: RiskParams = { maxPositionPct: 10, minCashFloorPct: 2 };

describe("checkRisk", () => {
  it("allows a buy within the position cap and cash floor", () => {
    const ctx: RiskContext = { side: "buy", symbol: "AAA", notional: 500, cash: 10_000, positionValues: {} };
    expect(checkRisk(ctx, params).ok).toBe(true);
  });

  it("rejects a buy that breaches the per-name position cap", () => {
    // portfolio = 10,000; 10% cap = 1,000; order 1,500 -> breach
    const ctx: RiskContext = { side: "buy", symbol: "AAA", notional: 1_500, cash: 10_000, positionValues: {} };
    const v = checkRisk(ctx, params);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Position cap/);
  });

  it("counts the existing position toward the cap", () => {
    // existing 800 + new 300 = 1,100 > 1,000 cap
    const ctx: RiskContext = { side: "buy", symbol: "AAA", notional: 300, cash: 5_000, positionValues: { AAA: 800, BBB: 5_000 } };
    expect(checkRisk(ctx, params).ok).toBe(false);
  });

  it("rejects a buy that breaches the cash floor", () => {
    // portfolio 10,000; floor 2% = 200; spending 9,900 leaves 100 < 200
    const ctx: RiskContext = { side: "buy", symbol: "AAA", notional: 9_900, cash: 10_000, positionValues: {} };
    const v = checkRisk(ctx, { maxPositionPct: 100, minCashFloorPct: 2 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Cash floor/);
  });

  it("never caps a sell", () => {
    const ctx: RiskContext = { side: "sell", symbol: "AAA", notional: 999_999, cash: 0, positionValues: { AAA: 1_000 } };
    expect(checkRisk(ctx, params).ok).toBe(true);
  });
});

describe("maxBuyNotional", () => {
  it("is bound by the position cap when cash is ample", () => {
    // portfolio 10,000; 10% cap = 1,000; cash floor allows up to 9,800 → cap binds
    expect(maxBuyNotional({ symbol: "AAA", cash: 10_000, positionValues: {} }, params)).toBeCloseTo(1_000, 5);
  });

  it("subtracts the existing position from the cap headroom", () => {
    // portfolio = 5,000 + 800 + 5,000 = 10,800; 10% cap = 1,080; holding 800 → 280 more allowed
    expect(maxBuyNotional({ symbol: "AAA", cash: 5_000, positionValues: { AAA: 800, BBB: 5_000 } }, params)).toBeCloseTo(280, 5);
  });

  it("is bound by the cash floor when cash is scarce", () => {
    // portfolio 10,000; floor 2% = 200; cash 1,000 → at most 800 deployable (cap would allow 1,000)
    expect(maxBuyNotional({ symbol: "AAA", cash: 1_000, positionValues: { BBB: 9_000 } }, params)).toBeCloseTo(800, 5);
  });

  it("returns 0 when no buy is permissible", () => {
    expect(maxBuyNotional({ symbol: "AAA", cash: 0, positionValues: {} }, params)).toBe(0);
    expect(maxBuyNotional({ symbol: "AAA", cash: 100, positionValues: { AAA: 2_000 } }, params)).toBe(0); // over cap already
  });

  it("agrees with checkRisk: any notional up to the max passes the gate", () => {
    const ctx = { symbol: "AAA", cash: 8_000, positionValues: { BBB: 2_000 } };
    const max = maxBuyNotional(ctx, params);
    expect(checkRisk({ side: "buy", notional: max, ...ctx }, params).ok).toBe(true);
    expect(checkRisk({ side: "buy", notional: max + 1, ...ctx }, params).ok).toBe(false);
  });
});

describe("sectorHeadroom", () => {
  // Two tech names already held; portfolio = 4,000 cash + 6,000 positions = 10,000.
  const sectorOf = (s: string) => ({ AAA: "tech", BBB: "tech", CCC: "energy" })[s] ?? null;
  const ctx = { cash: 4_000, positionValues: { AAA: 2_000, BBB: 1_000, CCC: 3_000 }, sectorOf };

  it("returns headroom to the sector cap net of existing same-sector exposure", () => {
    // tech cap 30% of 10,000 = 3,000; tech already holds 2,000 + 1,000 = 3,000 → 0 left
    expect(sectorHeadroom({ sector: "tech", ...ctx }, { maxSectorPct: 30 })).toBeCloseTo(0, 5);
    // energy holds 3,000; cap 3,000 → 0 left
    expect(sectorHeadroom({ sector: "energy", ...ctx }, { maxSectorPct: 30 })).toBeCloseTo(0, 5);
    // a fresh sector has the full cap available
    expect(sectorHeadroom({ sector: "health", ...ctx }, { maxSectorPct: 30 })).toBeCloseTo(3_000, 5);
  });

  it("does not cap unclassified (null) sectors", () => {
    expect(sectorHeadroom({ sector: null, ...ctx }, { maxSectorPct: 30 })).toBe(Infinity);
  });

  it("returns 0 for a non-positive portfolio", () => {
    expect(sectorHeadroom({ sector: "tech", cash: 0, positionValues: {}, sectorOf }, { maxSectorPct: 30 })).toBe(0);
  });
});
