import { describe, expect, it, vi } from "vitest";
import { AlpacaMarketData } from "./alpaca.js";
import {
  FinancialDatasetsFundamentals,
  mapMetrics,
  dividendYieldPctFrom,
  inventoryGrowthPctFromBalances,
  netCashPerShareFromBalance,
  insiderNetBuyingFromTrades,
} from "./financialdatasets.js";
import { withRetry, withCache, parseRetryAfter, MemoryFetchCache } from "./http.js";

const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

describe("FinancialDatasetsFundamentals", () => {
  it("maps the live API schema into Fundamentals (fractions → %, derived sales, FCF/share)", () => {
    const f = mapMetrics("AAPL", {
      report_period: "2025-09-27",
      price_to_earnings_ratio: 33.846,
      price_to_sales_ratio: 10,
      earnings_per_share_growth: 0.224, // 22.4%
      return_on_equity: 1.64, // 164% (buyback-heavy — normal for AAPL)
      debt_to_equity: 3.872,
      free_cash_flow_per_share: 6.607,
      revenue_growth: 0.064,
      payout_ratio: 0.136,
      market_cap: 2_000_000,
    });
    expect(f.peRatio).toBeCloseTo(33.846, 3);
    expect(f.epsGrowthPct).toBeCloseTo(22.4, 5);
    expect(f.roePct).toBeCloseTo(164, 5);
    expect(f.debtToEquity).toBe(3.872);
    expect(f.freeCashFlow).toBe(6.607); // from free_cash_flow_per_share
    expect(f.salesUsd).toBe(200_000); // market_cap / price_to_sales_ratio
    expect(f.dividendYieldPct).toBeCloseTo(0.4018, 3); // derived: payout_ratio / PE (0.136 / 33.846)
    expect(f.netCashPerShare).toBeNull(); // enriched from balance sheet, not base metrics
    expect(f.asOf).toBe("2025-09-27");
  });

  it("fetches with the API key, point-in-time filter, and builds growth history oldest→newest", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        financial_metrics: [
          { price_to_earnings_ratio: 12, report_period: "2025-06-30", earnings_per_share_growth: 0.2 },
          { price_to_earnings_ratio: 11, report_period: "2024-06-30", earnings_per_share_growth: 0.1 },
        ],
      }),
    );
    // enrich:false isolates the base /financial-metrics path (no balance-sheet/insider calls).
    const adapter = new FinancialDatasetsFundamentals({ apiKey: "k", enrich: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await adapter.getFundamentals("MSFT", "2026-01-01T00:00:00Z");
    expect(out.peRatio).toBe(12); // newest row
    expect(out.epsGrowthHistoryPct).toEqual([10, 20]); // oldest→newest, whole %
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no enrichment calls
    const calledUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("ticker=MSFT");
    expect(calledUrl).toContain("report_period_lte=2026-01-01");
  });

  it("throws on HTTP error", async () => {
    const adapter = new FinancialDatasetsFundamentals({
      apiKey: "k",
      fetchImpl: (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch,
    });
    await expect(adapter.getFundamentals("BAD")).rejects.toThrow(/404/);
  });

  it("enriches inventory growth, net cash, and insider buying from extra endpoints", async () => {
    // URL-routing mock: each endpoint returns its own payload (REST wrapper shapes).
    const fetchImpl = vi.fn(async (u: string) => {
      if (u.includes("/financial-metrics")) {
        return jsonResponse({
          financial_metrics: [
            { report_period: "2025-12-31", price_to_earnings_ratio: 20, payout_ratio: 0.5, revenue_growth: 0.1 },
          ],
        });
      }
      if (u.includes("/financials/balance-sheets")) {
        return jsonResponse({
          balance_sheets: [
            { report_period: "2025-12-31", inventory: 110, cash_and_equivalents: 500, current_investments: 100, total_debt: 200, outstanding_shares: 100 },
            { report_period: "2024-12-31", inventory: 100 },
          ],
        });
      }
      if (u.includes("/insider-trades")) {
        return jsonResponse({
          insider_trades: [
            { shares_owned_before_transaction: 1000, shares_owned_after_transaction: 1500 }, // +500 buy
            { transaction_type: "Open market sale", transaction_shares: 100 }, // -100 via type
          ],
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
    const adapter = new FinancialDatasetsFundamentals({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await adapter.getFundamentals("ENR", "2026-01-01T00:00:00Z");
    expect(out.inventoryGrowthPct).toBeCloseTo(10, 5); // (110-100)/100
    expect(out.netCashPerShare).toBeCloseTo(4, 5); // (500+100-200)/100
    expect(out.insiderNetBuying).toBe(true); // +500 - 100 = net buy
    expect(out.dividendYieldPct).toBeCloseTo(2.5, 5); // 0.5 / 20 * 100
    // insider window: filing_date_gte set ~365d before asOf.
    const insiderUrl = String((fetchImpl.mock.calls.find((c) => String(c[0]).includes("/insider-trades")) as unknown[])[0]);
    expect(insiderUrl).toContain("filing_date_lte=2026-01-01");
    expect(insiderUrl).toContain("filing_date_gte=2025-01-01");
  });

  it("survives enrichment endpoint failures (core fundamentals still returned)", async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      if (u.includes("/financial-metrics")) {
        return jsonResponse({ financial_metrics: [{ report_period: "2025-12-31", price_to_earnings_ratio: 15 }] });
      }
      return jsonResponse({}, false, 500); // both enrichment endpoints fail
    });
    const adapter = new FinancialDatasetsFundamentals({
      apiKey: "k",
      retry: { retries: 0 }, // don't retry the 500s in the test
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await adapter.getFundamentals("FAIL", "2026-01-01T00:00:00Z");
    expect(out.peRatio).toBe(15); // base metrics intact
    expect(out.inventoryGrowthPct).toBeNull();
    expect(out.netCashPerShare).toBeNull();
    expect(out.insiderNetBuying).toBeNull();
  });
});

describe("fundamentals enrichment helpers", () => {
  it("dividendYieldPctFrom is payout/PE, null for non-positive or missing PE", () => {
    expect(dividendYieldPctFrom(0.4, 20)).toBeCloseTo(2, 5);
    expect(dividendYieldPctFrom(0, 20)).toBe(0);
    expect(dividendYieldPctFrom(0.4, -5)).toBeNull(); // loss-maker
    expect(dividendYieldPctFrom(0.4, null)).toBeNull();
    expect(dividendYieldPctFrom(null, 20)).toBeNull();
  });

  it("inventoryGrowthPctFromBalances needs 2 rows with positive prior inventory", () => {
    expect(inventoryGrowthPctFromBalances([{ inventory: 120 }, { inventory: 100 }])).toBeCloseTo(20, 5);
    expect(inventoryGrowthPctFromBalances([{ inventory: 120 }])).toBeNull(); // one row
    expect(inventoryGrowthPctFromBalances([{ inventory: 120 }, { inventory: 0 }])).toBeNull(); // div-by-zero
    expect(inventoryGrowthPctFromBalances([{ inventory: 120 }, {}])).toBeNull(); // missing prior
  });

  it("netCashPerShareFromBalance counts cash + short-term inv − total debt per share", () => {
    expect(
      netCashPerShareFromBalance({ cash_and_equivalents: 300, current_investments: 200, total_debt: 100, outstanding_shares: 100 }),
    ).toBeCloseTo(4, 5);
    expect(netCashPerShareFromBalance({ cash_and_equivalents: 300, outstanding_shares: 0 })).toBeNull(); // no shares
    expect(netCashPerShareFromBalance({ outstanding_shares: 100 })).toBeNull(); // no cash
  });

  it("insiderNetBuyingFromTrades nets owned-share deltas, falls back to transaction_type, null if no signal", () => {
    expect(
      insiderNetBuyingFromTrades([
        { shares_owned_before_transaction: 100, shares_owned_after_transaction: 300 },
        { shares_owned_before_transaction: 300, shares_owned_after_transaction: 250 },
      ]),
    ).toBe(true); // +200 - 50
    expect(insiderNetBuyingFromTrades([{ transaction_type: "Open market sale", transaction_shares: 500 }])).toBe(false);
    expect(insiderNetBuyingFromTrades([{ transaction_type: "Open market purchase", transaction_shares: 500 }])).toBe(true);
    expect(insiderNetBuyingFromTrades([{ transaction_type: "Gift", transaction_shares: 50 }])).toBeNull(); // no direction
    expect(insiderNetBuyingFromTrades([])).toBeNull();
  });
});

describe("resilient fetch (http)", () => {
  it("parseRetryAfter handles delta-seconds and HTTP-date", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("garbage")).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });

  it("withRetry retries 429 honouring Retry-After, then returns the ok response", async () => {
    let calls = 0;
    const slept: number[] = [];
    const base = vi.fn(async () => {
      calls++;
      return calls < 3
        ? ({ ok: false, status: 429, headers: { get: () => "3" }, json: async () => ({}) } as unknown as Response)
        : jsonResponse({ done: true });
    });
    const f = withRetry(base as unknown as typeof fetch, { sleep: async (ms) => void slept.push(ms) });
    const res = await f("http://x");
    expect(await res.json()).toEqual({ done: true });
    expect(calls).toBe(3);
    expect(slept).toEqual([3000, 3000]); // Retry-After honoured both times
  });

  it("withRetry retries network-level failures (fetch failed) but not aborts", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      if (++calls < 3) throw new TypeError("fetch failed");
      return jsonResponse({ done: true });
    });
    const f = withRetry(flaky as unknown as typeof fetch, { sleep: async () => {} });
    expect(await (await f("http://x")).json()).toEqual({ done: true });
    expect(calls).toBe(3);
    const down = withRetry((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, { retries: 2, sleep: async () => {} });
    await expect(down("http://x")).rejects.toThrow("fetch failed");
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    let aborts = 0;
    const aborted = withRetry((async () => { aborts++; throw abort; }) as unknown as typeof fetch, { sleep: async () => {} });
    await expect(aborted("http://x")).rejects.toThrow("aborted");
    expect(aborts).toBe(1);
  });

  it("withRetry gives up after the retry budget and returns the last response", async () => {
    const base = vi.fn(async () => jsonResponse({}, false, 503));
    const f = withRetry(base as unknown as typeof fetch, { retries: 2, sleep: async () => {} });
    const res = await f("http://x");
    expect(res.status).toBe(503);
    expect(base).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("withCache memoises GETs within TTL and re-fetches after expiry", async () => {
    let n = 0;
    const base = vi.fn(async () => new Response(JSON.stringify({ n: n++ }), { status: 200 }));
    let clock = 1000;
    const f = withCache(base as unknown as typeof fetch, { ttlMs: 100, cache: new MemoryFetchCache(() => clock) });
    expect(await (await f("http://x")).json()).toEqual({ n: 0 });
    expect(await (await f("http://x")).json()).toEqual({ n: 0 }); // cache hit
    expect(base).toHaveBeenCalledTimes(1);
    clock += 200; // past TTL
    expect(await (await f("http://x")).json()).toEqual({ n: 1 }); // re-fetched
    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe("FinancialDatasetsFundamentals point-in-time cutoff", () => {
  /** Captures the report_period_lte the adapter asks for. */
  const captureCutoff = async (reportingLagDays?: number) => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({
        financial_metrics: [{ report_period: "2024-12-31", price_to_earnings_ratio: 10, market_cap: 1 }],
      });
    });
    const fd = new FinancialDatasetsFundamentals({
      apiKey: "k",
      enrich: false,
      reportingLagDays,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fd.getFundamentals("AAPL", "2026-01-15T00:00:00Z");
    return new URL(urls[0]!).searchParams.get("report_period_lte");
  };

  it("defaults to no lag — the clock date itself (live analysis)", async () => {
    expect(await captureCutoff()).toBe("2026-01-15");
  });

  it("shifts the cutoff back by the publication lag so a backtest cannot see unfiled reports", async () => {
    // 15-Jan-2026 minus 90d = 17-Oct-2025, so FY2025 (period end 31-Dec-2025, filed ~Feb-2026)
    // is correctly INVISIBLE at this clock.
    expect(await captureCutoff(90)).toBe("2025-10-17");
  });

  it("advertises its source id so provenance is never a generic label", () => {
    const fd = new FinancialDatasetsFundamentals({ apiKey: "k" });
    expect(fd.sourceId).toBe("financialdatasets.ai");
  });
});

describe("AlpacaMarketData", () => {
  it("never asks delayed SIP for the last 15 minutes (Basic plan refuses the whole request)", async () => {
    const now = Date.parse("2026-09-16T15:00:00Z");
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (u: string) => {
      seen.push(String(u));
      return jsonResponse({ bars: [{ t: "2026-09-16T04:00:00Z", o: 1, h: 1, l: 1, c: 99, v: 1 }] });
    });
    const sip = new AlpacaMarketData({ keyId: "k", secretKey: "s", feed: "sip", now: () => now, fetchImpl: fetchImpl as unknown as typeof fetch });
    await sip.getBars("AAA", "2026-09-01T00:00:00Z", "2026-09-16T15:00:00Z");
    expect(new URL(seen[0]!).searchParams.get("end")).toBe("2026-09-16T14:44:00.000Z");
    // A historical window is left alone.
    await sip.getBars("AAA", "2020-01-01T00:00:00Z", "2020-06-01T00:00:00Z");
    expect(new URL(seen[1]!).searchParams.get("end")).toBe("2020-06-01T00:00:00Z");
    // "Latest" goes through delayed bars, not the real-time endpoint.
    expect(await sip.getLatestPrice("AAA")).toBe(99);
    expect(seen.slice(2).every((u) => !u.includes("/bars/latest"))).toBe(true);

    const iex = new AlpacaMarketData({ keyId: "k", secretKey: "s", feed: "iex", now: () => now, fetchImpl: fetchImpl as unknown as typeof fetch });
    await iex.getBars("AAA", "2026-09-01T00:00:00Z", "2026-09-16T15:00:00Z");
    expect(new URL(seen.at(-1)!).searchParams.get("end")).toBe("2026-09-16T15:00:00Z");
  });

  it("maps bars and respects the point-in-time clock for latest price (NO future)", async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      // Both latest-price-with-clock and getBars go through the bars endpoint.
      expect(u).toContain("/v2/stocks/AAA/bars");
      return jsonResponse({
        bars: [
          { t: "2026-01-01T00:00:00Z", o: 5, h: 6, l: 4, c: 5, v: 100 },
          { t: "2026-02-01T00:00:00Z", o: 7, h: 8, l: 6, c: 7, v: 200 },
        ],
      });
    });
    const adapter = new AlpacaMarketData({ keyId: "k", secretKey: "s", fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await adapter.getLatestPrice("AAA", "2026-03-01T00:00:00Z");
    expect(price).toBe(7); // last bar's close, not a live "now" price
  });

  it("FOLLOWS PAGINATION — a truncated series silently freezes prices", async () => {
    // REGRESSION: Alpaca caps a page at 1000 bars and returns next_page_token. Ignoring it made a
    // 2016->2025 query end at 2024-07-16, so getLatestPrice returned that close for EVERY later
    // clock. A real backtest marked 18 months of portfolio AND benchmark at frozen prices with no
    // error raised — the strategy looked flat while the market moved.
    const pages: Record<string, unknown> = {
      "": {
        bars: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 1, l: 1, c: 10, v: 1 }],
        next_page_token: "P2",
      },
      P2: {
        bars: [{ t: "2026-02-01T00:00:00Z", o: 1, h: 1, l: 1, c: 20, v: 1 }],
        next_page_token: "P3",
      },
      P3: { bars: [{ t: "2026-03-01T00:00:00Z", o: 1, h: 1, l: 1, c: 30, v: 1 }], next_page_token: null },
    };
    const fetchImpl = vi.fn(async (u: string) => {
      const token = new URL(String(u)).searchParams.get("page_token") ?? "";
      return jsonResponse(pages[token]);
    });
    const adapter = new AlpacaMarketData({ keyId: "k", secretKey: "s", fetchImpl: fetchImpl as unknown as typeof fetch });
    const bars = await adapter.getBars("AAA", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
    expect(bars).toHaveLength(3); // all pages, not just the first
    expect(bars.at(-1)!.close).toBe(30); // the CURRENT price, not a stale first-page close
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("queries a BOUNDED lookback for a point-in-time price, not the full history", async () => {
    // Fetching from 2016 to read one close is both wasteful and what hit the pagination cap.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (u: string) => {
      seen.push(String(u));
      return jsonResponse({ bars: [{ t: "2026-02-27T00:00:00Z", o: 1, h: 1, l: 1, c: 42, v: 1 }] });
    });
    const adapter = new AlpacaMarketData({ keyId: "k", secretKey: "s", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await adapter.getLatestPrice("AAA", "2026-03-01T00:00:00Z")).toBe(42);
    const start = new URL(seen[0]!).searchParams.get("start")!;
    // Window must be recent relative to the clock, not an epoch-style start date.
    expect(Date.parse("2026-03-01T00:00:00Z") - Date.parse(start)).toBeLessThan(30 * 86_400_000);
  });

  it("RETRIES a 429 instead of throwing — throttling must not look like a delisted symbol", async () => {
    // REGRESSION: AlpacaMarketData did not wrap fetch in withRetry, so a rate-limited price fetch
    // threw. The backtest loop caught that as "not yet listed as of clock (survivorship-safe)" and
    // silently dropped the name from that rebalance — throttling quietly shrank the universe.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 429, headers: { get: () => "0" } } as unknown as Response;
      return jsonResponse({ bars: [{ t: "2026-02-27T00:00:00Z", o: 1, h: 1, l: 1, c: 55, v: 1 }] });
    });
    const adapter = new AlpacaMarketData({
      keyId: "k",
      secretKey: "s",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { retries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    expect(await adapter.getLatestPrice("AAA", "2026-03-01T00:00:00Z")).toBe(55);
    expect(call).toBe(2); // retried rather than surfacing the 429 as a missing symbol
  });

  it("widens the lookback when the first window is empty (holidays / halts)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      // First window returns nothing; second yields a bar.
      return jsonResponse(call === 1 ? { bars: [] } : { bars: [{ t: "2026-01-15T00:00:00Z", o: 1, h: 1, l: 1, c: 99, v: 1 }] });
    });
    const adapter = new AlpacaMarketData({ keyId: "k", secretKey: "s", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await adapter.getLatestPrice("AAA", "2026-03-01T00:00:00Z")).toBe(99);
    expect(call).toBe(2);
  });
});
