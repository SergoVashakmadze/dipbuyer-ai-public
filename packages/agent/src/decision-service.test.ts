import { describe, expect, it } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import { InMemoryFundamentals } from "@dipbuyer/data";
import { hashDecision } from "@dipbuyer/chain";
import { DecisionService } from "./decision-service.js";
import { InMemoryDecisionStore } from "./store.js";

const f = (symbol: string, asOf: string, over: Partial<Fundamentals>): Fundamentals =>
  ({ symbol, asOf, peRatio: 12, epsGrowthPct: 25, epsGrowthHistoryPct: [22, 24, 25], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: 30, inventoryGrowthPct: 10, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: 18, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null, ...over }) as Fundamentals;

const svc = (snaps: Array<[string, Fundamentals[]]>) =>
  new DecisionService({ fundamentals: new InMemoryFundamentals(new Map(snaps)) });

describe("DecisionService", () => {
  it("produces a complete, hashable DecisionRecord end-to-end", async () => {
    const s = svc([["AAA", [f("AAA", "2026-01-01T00:00:00Z", { peRatio: 12 })]]]);
    const { record, hash } = await s.analyze("AAA", { mode: "RESEARCH_ONLY", execution: "PAPER" });
    expect(record.symbol).toBe("AAA");
    expect(record.lynchCategory).toBe("fast_grower");
    expect(["buy", "hold"]).toContain(record.verdict);
    expect(record.criteria.length).toBeGreaterThan(0);
    expect(record.model.strategyConfigHash).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDecision(record)).toBe(hash); // hash matches the record verbatim
  });

  it("respects the point-in-time clock", async () => {
    const s = svc([
      ["AAA", [f("AAA", "2026-01-01T00:00:00Z", { peRatio: 12 }), f("AAA", "2026-06-01T00:00:00Z", { peRatio: 60 })]],
    ]);
    // As of Feb, only the cheap Jan snapshot is visible.
    const early = await s.analyze("AAA", { mode: "RESEARCH_ONLY", execution: "PAPER", asOf: "2026-02-01T00:00:00Z" });
    expect(early.record.criteria.find((c) => c.name === "PEG")?.value).toBe(0.48);
    // As of July, the expensive snapshot triggers a sell (PEG 60/25 = 2.4 >= 2.0).
    const late = await s.analyze("AAA", { mode: "RESEARCH_ONLY", execution: "PAPER", asOf: "2026-07-01T00:00:00Z" });
    expect(late.record.verdict).toBe("sell");
  });

  it("persists every analysed record to the store when provided", async () => {
    const store = new InMemoryDecisionStore();
    const s = new DecisionService({
      fundamentals: new InMemoryFundamentals(new Map([["AAA", [f("AAA", "2026-01-01T00:00:00Z", { peRatio: 12 })]]])),
      store,
    });
    await s.analyze("AAA", { mode: "RESEARCH_ONLY", execution: "PAPER" });
    const recent = await store.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.symbol).toBe("AAA");
    expect(await store.latestFor("AAA")).not.toBeNull();
  });

  it("screen() returns buy candidates ranked by conviction", async () => {
    const s = svc([
      ["GOOD", [f("GOOD", "2026-01-01T00:00:00Z", { peRatio: 10 })]],
      ["RICH", [f("RICH", "2026-01-01T00:00:00Z", { peRatio: 60 })]], // PEG 2.4 -> sell, excluded
    ]);
    const picks = await s.screen(["GOOD", "RICH"], { mode: "RESEARCH_ONLY", execution: "PAPER" });
    expect(picks.map((p) => p.record.symbol)).toEqual(["GOOD"]);
  });

  it("skips the audit store when persist is false and exposes the inputs behind the verdict", async () => {
    const store = new InMemoryDecisionStore();
    const s = new DecisionService({
      fundamentals: new InMemoryFundamentals(new Map([["AAA", [f("AAA", "2026-01-01T00:00:00Z", { peRatio: 12 })]]])),
      store,
    });
    const out = await s.analyzeWithInputs("AAA", { mode: "RESEARCH_ONLY", execution: "PAPER", persist: false });
    expect(await store.recent()).toHaveLength(0);
    expect(out.fundamentals.peRatio).toBe(12);
    expect(out.sourceId).toBe("in-memory-demo");
    expect(hashDecision(out.output.record)).toBe(out.output.hash);
  });
});
