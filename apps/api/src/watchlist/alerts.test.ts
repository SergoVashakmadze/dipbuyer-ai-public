import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, detectAlerts, type StockState } from "./alerts.js";

const s = (over: Partial<StockState>): StockState => ({
  verdict: "hold", convictionScore: 60, price: 100, drawdown: 0.05, lastInsiderFiled: null, lastInsiderSummary: null, ...over,
});

describe("detectAlerts", () => {
  it("records a baseline on the first check and never alerts on it", () => {
    expect(detectAlerts("KO", DEFAULT_RULES, null, s({ verdict: "buy", drawdown: 0.4 }))).toEqual([]);
  });

  it("alerts when the verdict turns buy, not while it stays buy", () => {
    expect(detectAlerts("KO", DEFAULT_RULES, s({}), s({ verdict: "buy", convictionScore: 74 })).map((a) => a.kind)).toEqual(["buy_verdict"]);
    expect(detectAlerts("KO", DEFAULT_RULES, s({ verdict: "buy" }), s({ verdict: "buy" }))).toEqual([]);
  });

  it("alerts once when the drawdown crosses the threshold", () => {
    const crossed = detectAlerts("KO", DEFAULT_RULES, s({ drawdown: 0.1 }), s({ drawdown: 0.18, price: 82 }));
    expect(crossed).toEqual([{ kind: "dip", message: "KO is 18% below its 52-week high at $82.00 (your alert: 15%)." }]);
    expect(detectAlerts("KO", DEFAULT_RULES, s({ drawdown: 0.18 }), s({ drawdown: 0.25 }))).toEqual([]);
  });

  it("alerts on a newer insider filing only, and respects switched-off rules", () => {
    const before = s({ lastInsiderFiled: "2026-09-10" });
    const now = s({ lastInsiderFiled: "2026-09-15", lastInsiderSummary: "Jane Doe (CEO) bought $250k" });
    expect(detectAlerts("KO", DEFAULT_RULES, before, now).map((a) => a.message)).toEqual(["Insider buying at KO: Jane Doe (CEO) bought $250k."]);
    expect(detectAlerts("KO", { buy: false, dipPct: null, insider: false }, s({}), s({ verdict: "buy", drawdown: 0.5, lastInsiderFiled: "2026-09-15" }))).toEqual([]);
  });
});
