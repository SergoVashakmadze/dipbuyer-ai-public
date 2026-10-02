import { describe, expect, it } from "vitest";
import { isSyntheticSource } from "./index.js";
import { parseFundamentalsDataset } from "./dataset.js";

const snap = (symbol: string, asOf: string, peRatio: number) => ({ symbol, asOf, peRatio, epsGrowthPct: 20 });

describe("fundamentals dataset loader", () => {
  it("flags synthetic datasets so they can never pass as real analysis", async () => {
    const { adapter } = parseFundamentalsDataset({
      source: "fca-sandbox/equities-v1",
      synthetic: true,
      snapshots: [snap("aaa", "2026-01-01T00:00:00Z", 10)],
    });
    expect(adapter.sourceId).toBe("synthetic:fca-sandbox/equities-v1");
    expect(isSyntheticSource(adapter.sourceId)).toBe(true);
    const f = await adapter.getFundamentals("AAA");
    expect(f.peRatio).toBe(10);
    expect(f.dividendYieldPct).toBeNull(); // absent = unknown, never 0
    expect(f.epsGrowthHistoryPct).toEqual([]);
  });

  it("keeps point-in-time discipline across snapshots", async () => {
    const { adapter } = parseFundamentalsDataset({
      source: "vendor-x",
      synthetic: false,
      snapshots: [snap("AAA", "2026-01-01T00:00:00Z", 10), snap("AAA", "2026-04-01T00:00:00Z", 20)],
    });
    expect(isSyntheticSource(adapter.sourceId)).toBe(false);
    expect((await adapter.getFundamentals("AAA", "2026-02-01T00:00:00Z")).peRatio).toBe(10);
  });

  it("rejects datasets that do not declare provenance or are malformed", () => {
    expect(() => parseFundamentalsDataset({ source: "x", snapshots: [snap("A", "2026-01-01", 1)] })).toThrow(/synthetic/);
    expect(() => parseFundamentalsDataset({ synthetic: true, snapshots: [snap("A", "2026-01-01", 1)] })).toThrow(/source/);
    expect(() => parseFundamentalsDataset({ source: "x", synthetic: true, snapshots: [] })).toThrow(/snapshots/);
    expect(() => parseFundamentalsDataset({ source: "x", synthetic: true, snapshots: [{ symbol: "A", asOf: "nope" }] })).toThrow(/asOf/);
  });
});
