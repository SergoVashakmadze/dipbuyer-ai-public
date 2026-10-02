import { describe, expect, it } from "vitest";
import { attribute, performanceSeries, type LedgerEntry } from "./ledger.js";

let n = 0;
const e = (source: LedgerEntry["source"], symbol: string, side: "buy" | "sell", qty: number, price: number, status = "filled"): LedgerEntry => ({
  id: String(++n),
  ts: `2026-09-18T10:00:${String(n).padStart(2, "0")}Z`,
  userId: "u1",
  source,
  symbol,
  side,
  qty,
  price,
  status,
});
const px = (m: Record<string, number>) => (s: string) => m[s] ?? 0;

describe("attribute", () => {
  it("splits one broker position between the agent and the investor by the ledger", () => {
    const a = attribute([e("agent", "AAPL", "buy", 10, 100), e("self", "AAPL", "buy", 5, 120)], [{ symbol: "AAPL", qty: 15, avgEntryPrice: 106.67 }], px({ AAPL: 130 }));
    expect(a.bySymbol.AAPL).toEqual([
      { sleeve: "agent", qty: 10, cost: 1000, value: 1300 },
      { sleeve: "self", qty: 5, cost: 600, value: 650 },
    ]);
    expect(a.sleeves.map((s) => [s.sleeve, s.unrealized])).toEqual([
      ["agent", 300],
      ["self", 50],
    ]);
  });

  it("marks what the ledger cannot explain as unattributed, at the broker's cost", () => {
    const a = attribute([e("core", "SPY", "buy", 10, 500)], [{ symbol: "SPY", qty: 12, avgEntryPrice: 490 }], px({ SPY: 510 }));
    expect(a.bySymbol.SPY).toContainEqual({ sleeve: "unattributed", qty: 2, cost: 980, value: 1020 });
  });

  it("scales sources down when orders were submitted but never filled", () => {
    const a = attribute([e("agent", "KO", "buy", 10, 60), e("self", "KO", "buy", 10, 60)], [{ symbol: "KO", qty: 10, avgEntryPrice: 60 }], px({ KO: 60 }));
    expect(a.bySymbol.KO!.map((h) => h.qty)).toEqual([5, 5]);
  });

  it("ignores rejected orders and books realized P&L on sells at average cost", () => {
    const a = attribute(
      [e("self", "JPM", "buy", 10, 100), e("self", "JPM", "buy", 10, 200, "rejected"), e("self", "JPM", "sell", 4, 150)],
      [{ symbol: "JPM", qty: 6, avgEntryPrice: 100 }],
      px({ JPM: 150 }),
    );
    const self = a.sleeves.find((s) => s.sleeve === "self")!;
    expect(self).toMatchObject({ value: 900, cost: 600, unrealized: 300, realized: 200 });
  });

  it("takes an investor's sell of agent-bought shares out of the agent lot, never below zero", () => {
    const a = attribute([e("agent", "NKE", "buy", 10, 50), e("self", "NKE", "sell", 4, 60)], [{ symbol: "NKE", qty: 6, avgEntryPrice: 50 }], px({ NKE: 60 }));
    expect(a.bySymbol.NKE).toEqual([{ sleeve: "agent", qty: 6, cost: 300, value: 360 }]);
    expect(a.sleeves.find((s) => s.sleeve === "agent")!.realized).toBe(40);
  });
});

describe("performanceSeries", () => {
  it("rebases the portfolio and the benchmark to 100 at the first snapshot", () => {
    const s = performanceSeries([
      { date: "2026-09-19", equity: 110_000, cash: 0, sleeves: {}, benchmark: 105 },
      { date: "2026-09-18", equity: 100_000, cash: 0, sleeves: {}, benchmark: 100 },
    ]);
    expect(s).toEqual([
      { date: "2026-09-18", portfolio: 100, benchmark: 100 },
      { date: "2026-09-19", portfolio: 110, benchmark: 105 },
    ]);
  });
});
