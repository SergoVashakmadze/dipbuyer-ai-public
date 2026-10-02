import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BacktestService, buildBacktestData } from "./backtest.service.js";

/**
 * run() selects its data source from env, so these tests MUST pin it. Without this a developer
 * with ALPACA_KEY_ID exported would silently make the suite hit the live network — slow, flaky,
 * and rate-limited.
 */
const DATA_ENV = [
  "BACKTEST_PRICE_SOURCE",
  "POLYGON_API_KEY",
  "POLYGON_BASE_URL",
  "ALPACA_DATA_FEED",
  "ALPACA_KEY_ID",
  "ALPACA_SECRET_KEY",
  "SEC_EDGAR_USER_AGENT",
  "FINANCIALDATASETS_API_KEY",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(DATA_ENV.map((k) => [k, process.env[k]]));
  for (const k of DATA_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of DATA_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildBacktestData source selection", () => {
  const args = () => ["AAPL"] as string[];
  const sched = () => ["2025-01-01T00:00:00Z"];

  it("falls back to synthetic without Alpaca, even when a fundamentals source exists", () => {
    // Real fundamentals against fixture prices is a meaningless hybrid — fall back wholesale.
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    const out = buildBacktestData(args(), sched());
    expect(out.fundamentals.sourceId).toBe("backtest-synthetic");
    expect(out.exactFilingDates).toBe(false);
  });

  it("prefers SEC EDGAR over the paid source — exact filing dates beat a lag estimate", () => {
    process.env.ALPACA_KEY_ID = "k";
    process.env.ALPACA_SECRET_KEY = "s";
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    process.env.FINANCIALDATASETS_API_KEY = "paid";
    const out = buildBacktestData(args(), sched());
    expect(out.fundamentals.sourceId).toBe("sec-edgar");
    expect(out.exactFilingDates).toBe(true);
    expect(out.lagDays).toBeNull(); // no estimate needed
  });

  it("uses financialdatasets with the 90d publication lag when EDGAR is unavailable", () => {
    process.env.ALPACA_KEY_ID = "k";
    process.env.ALPACA_SECRET_KEY = "s";
    process.env.FINANCIALDATASETS_API_KEY = "paid";
    const out = buildBacktestData(args(), sched());
    expect(out.fundamentals.sourceId).toBe("financialdatasets.ai");
    expect(out.exactFilingDates).toBe(false);
    expect(out.lagDays).toBe(90);
  });

  it("is synthetic when nothing is configured", () => {
    const out = buildBacktestData(args(), sched());
    expect(out.fundamentals.sourceId).toBe("backtest-synthetic");
    expect(out.marketDataSource).toBe("in-memory-demo");
    expect(out.marketDataFeed).toBeNull();
  });
});

describe("buildBacktestData price source (BACKTEST_PRICE_SOURCE)", () => {
  const args = () => ["AAPL"] as string[];
  const sched = () => ["2025-01-01T00:00:00Z"];

  it("defaults to alpaca and records the feed (default iex) — existing runs unchanged", () => {
    process.env.ALPACA_KEY_ID = "k";
    process.env.ALPACA_SECRET_KEY = "s";
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    process.env.POLYGON_API_KEY = "p"; // present but NOT selected — must not switch source
    const out = buildBacktestData(args(), sched());
    expect(out.marketDataSource).toBe("alpaca");
    expect(out.marketDataFeed).toBe("iex");
    expect(out.fundamentals.sourceId).toBe("sec-edgar");
  });

  it("records the SIP feed when configured", () => {
    process.env.ALPACA_KEY_ID = "k";
    process.env.ALPACA_SECRET_KEY = "s";
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    process.env.ALPACA_DATA_FEED = "sip";
    expect(buildBacktestData(args(), sched()).marketDataFeed).toBe("sip");
  });

  it("polygon does NOT need Alpaca keys, and runs on real fundamentals", () => {
    process.env.BACKTEST_PRICE_SOURCE = "polygon";
    process.env.POLYGON_API_KEY = "p";
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    const out = buildBacktestData(args(), sched());
    expect(out.marketDataSource).toBe("polygon");
    expect(out.marketDataFeed).toBeNull();
    expect(out.fundamentals.sourceId).toBe("sec-edgar");
  });

  it("polygon without POLYGON_API_KEY throws instead of silently running on something else", () => {
    process.env.BACKTEST_PRICE_SOURCE = "polygon";
    process.env.ALPACA_KEY_ID = "k";
    process.env.ALPACA_SECRET_KEY = "s";
    process.env.SEC_EDGAR_USER_AGENT = "t t@e.com";
    expect(() => buildBacktestData(args(), sched())).toThrow(/POLYGON_API_KEY/);
  });

  it("rejects an unknown source rather than falling back", () => {
    process.env.BACKTEST_PRICE_SOURCE = "polygn";
    expect(() => buildBacktestData(args(), sched())).toThrow(/BACKTEST_PRICE_SOURCE="polygn"/);
  });
});

describe("BacktestService", () => {
  it("applies sensible defaults (AAPL/MSFT, $10k, monthly) and returns a real equity curve", async () => {
    const out = await new BacktestService().run({});
    expect(out.params.universe).toEqual(["AAPL", "MSFT"]);
    expect(out.params.initialCapital).toBe(10_000);
    expect(out.params.rebalance).toBe("monthly");
    expect(out.equityCurve.length).toBeGreaterThan(1);
    expect(out.decisions).toBeGreaterThan(0);
    // Provenance names the price adapter actually used, and the cash-drag metric is reported.
    expect(out.dataSource).toEqual({ fundamentals: "backtest-synthetic", marketData: "in-memory-demo", marketDataFeed: null, synthetic: true });
    expect(out.metrics.avgCashPct).toBeGreaterThanOrEqual(0);
    expect(out.metrics.avgCashPct).toBeLessThanOrEqual(100);
  });

  it("buys cheap fast growers → equity rises with the price series", async () => {
    const out = await new BacktestService().run({ universe: ["aaa"], from: "2025-01-01T00:00:00Z", to: "2025-06-30T00:00:00Z" });
    expect(out.params.universe).toEqual(["AAA"]); // upper-cased
    expect(out.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(out.equityCurve.at(-1)!.value).toBeGreaterThan(10_000);
  });

  it("never buys expensive names (PEG>=2) → equity stays flat at the initial capital", async () => {
    const out = await new BacktestService().run({ universe: ["RICHCO"], from: "2025-01-01T00:00:00Z", to: "2025-06-30T00:00:00Z" });
    expect(out.metrics.totalReturnPct).toBe(0);
    expect(out.equityCurve.every((p) => p.value === 10_000)).toBe(true);
    expect(out.decisions).toBeGreaterThan(0); // a (sell/avoid) decision was still recorded
  });

  it("spaces the rebalance schedule by the chosen cadence", async () => {
    // 30-day span, monthly step (30d) → 2 marks (t0 and t0+30d).
    const out = await new BacktestService().run({ from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z", rebalance: "monthly" });
    expect(out.equityCurve).toHaveLength(2);
    // Same span, weekly step (7d) → t0,7,14,21,28 ≤ 31 → 5 marks.
    const weekly = await new BacktestService().run({ from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z", rebalance: "weekly" });
    expect(weekly.equityCurve).toHaveLength(5);
  });

  it("supports quarterly and annual cadences (the long-hold horizons the edge lives at)", async () => {
    // Attribution showed the conviction signal only emerges over 1-5yr holds, so these cadences
    // are the point. A 2-year span steps at 91d (quarterly) → t0 + ~8 marks, and at 365d
    // (annual) → t0, t0+1y ≤ 2y → 3 marks. Just assert the step spacing is honoured and the
    // metrics annualise (PERIODS_PER_YEAR must know the new cadences or CAGR silently breaks).
    const q = await new BacktestService().run({ from: "2024-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z", rebalance: "quarterly" });
    expect(q.equityCurve.length).toBeGreaterThan(6);
    expect(Number.isFinite(q.metrics.cagrPct)).toBe(true);
    const a = await new BacktestService().run({ from: "2024-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z", rebalance: "annual" });
    expect(a.equityCurve).toHaveLength(3); // t0, +365d, +730d all ≤ 730d span
    expect(Number.isFinite(a.metrics.cagrPct)).toBe(true);
  });
});

describe("experiment switches", () => {
  it("parses BACKTEST_CASH_POLICY and refuses typos rather than silently running the default", async () => {
    const { backtestCashPolicy } = await import("./backtest.service.js");
    expect(backtestCashPolicy({})).toBe("benchmark"); // R5 default
    expect(backtestCashPolicy({ BACKTEST_CASH_POLICY: "none" })).toBe("none");
    expect(backtestCashPolicy({ BACKTEST_CASH_POLICY: "TBill" })).toBe("tbill");
    expect(backtestCashPolicy({ BACKTEST_CASH_POLICY: "benchmark" })).toBe("benchmark");
    expect(() => backtestCashPolicy({ BACKTEST_CASH_POLICY: "spy" })).toThrow(/not one of/);
  });

  it("loads the validated delisted-ticker CIK overrides by default, and can be switched off", async () => {
    const { backtestCikOverrides } = await import("./backtest.service.js");
    expect(backtestCikOverrides({ BACKTEST_CIK_OVERRIDES: "0" })).toBeUndefined();
    const map = backtestCikOverrides({})!;
    expect(Object.keys(map).length).toBeGreaterThan(100);
    expect(map.ABC).toBe("1140859"); // AmerisourceBergen, pre-rename to Cencora
    expect(Object.values(map).every((cik) => /^\d+$/.test(cik))).toBe(true);
  });
});
