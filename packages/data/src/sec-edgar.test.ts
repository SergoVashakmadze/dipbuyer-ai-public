import { describe, expect, it, vi } from "vitest";
import { SecEdgarFundamentals } from "./sec-edgar.js";

const TICKERS = { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } };

/** Annual (duration) fact — income-statement style. */
const flow = (end: string, val: number, filed: string, start?: string) => ({
  start: start ?? `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`,
  end,
  val,
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form: "10-K",
  filed,
});

/** Instantaneous (point) fact — balance-sheet style, no start. */
const point = (end: string, val: number, filed: string) => ({
  end,
  val,
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form: "10-K",
  filed,
});

const facts = (over: Record<string, unknown> = {}) => ({
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      EarningsPerShareDiluted: {
        units: {
          "USD/shares": [
            flow("2023-09-30", 6.13, "2023-11-03"),
            flow("2024-09-28", 6.08, "2024-11-01"),
            flow("2025-09-27", 7.46, "2025-10-31"),
          ],
        },
      },
      Revenues: {
        units: {
          USD: [flow("2024-09-28", 391_035_000_000, "2024-11-01"), flow("2025-09-27", 416_161_000_000, "2025-10-31")],
        },
      },
      NetIncomeLoss: { units: { USD: [flow("2025-09-27", 112_010_000_000, "2025-10-31")] } },
      StockholdersEquity: { units: { USD: [point("2025-09-27", 56_950_000_000, "2025-10-31")] } },
      Liabilities: { units: { USD: [point("2025-09-27", 300_000_000_000, "2025-10-31")] } },
      AssetsCurrent: { units: { USD: [point("2025-09-27", 150_000_000_000, "2025-10-31")] } },
      LiabilitiesCurrent: { units: { USD: [point("2025-09-27", 120_000_000_000, "2025-10-31")] } },
      LongTermDebtNoncurrent: { units: { USD: [point("2025-09-27", 80_000_000_000, "2025-10-31")] } },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { USD: [point("2025-09-27", 30_000_000_000, "2025-10-31")] },
      },
      WeightedAverageNumberOfDilutedSharesOutstanding: {
        units: { shares: [flow("2025-09-27", 15_000_000_000, "2025-10-31")] },
      },
      ...over,
    },
  },
});

/**
 * Returns REAL Response objects, not `{ok, json}` stubs — the adapter wraps fetch in withCache,
 * which calls res.clone(). A stub would pass a cacheless adapter and fail a cached one, hiding
 * the difference the cache is supposed to make.
 */
const makeFetch = (body: unknown, tickers: unknown = TICKERS) =>
  vi.fn(async (url: string) => {
    const payload = String(url).includes("company_tickers") ? tickers : body;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

const adapter = (fetchImpl: ReturnType<typeof makeFetch>, marketData?: unknown) =>
  new SecEdgarFundamentals({
    userAgent: "test test@example.com",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    marketData: marketData as never,
  });

describe("SecEdgarFundamentals", () => {
  it("advertises its source id for provenance", () => {
    expect(adapter(makeFetch(facts())).sourceId).toBe("sec-edgar");
  });

  it("derives ratios from raw XBRL concepts", async () => {
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2026-01-01");
    expect(f.symbol).toBe("AAPL");
    expect(f.epsGrowthPct).toBeCloseTo(((7.46 / 6.13) ** (1 / 2) - 1) * 100, 4); // 2-year CAGR, not one year
    expect(f.revenueGrowthPct).toBeCloseTo(((416161 - 391035) / 391035) * 100, 4);
    expect(f.debtToEquity).toBeCloseTo(80_000_000_000 / 56_950_000_000, 6);
    expect(f.currentRatio).toBeCloseTo(150 / 120, 6);
    expect(f.roePct).toBeCloseTo((112_010 / 56_950) * 100, 3);
    expect(f.salesUsd).toBe(416_161_000_000);
    // (cash 30bn + STI 0 - debt 80bn) / 15bn shares
    expect(f.netCashPerShare).toBeCloseTo(-50 / 15, 6);
  });

  it("EXACT point-in-time: a report filed AFTER the clock is invisible", async () => {
    // FY2025 was filed 2025-10-31. Standing at 2025-10-01 the market had only FY2024.
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2025-10-01");
    expect(f.asOf).toBe("2024-09-28");
    // Growth must come from FY2023->FY2024, NOT the unfiled FY2025.
    expect(f.epsGrowthPct).toBeCloseTo(((6.08 - 6.13) / 6.13) * 100, 4);
  });

  it("becomes visible the day it is filed", async () => {
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2025-10-31");
    expect(f.asOf).toBe("2025-09-27");
    expect(f.epsGrowthPct).toBeCloseTo(((7.46 / 6.13) ** (1 / 2) - 1) * 100, 4); // 2-year CAGR, not one year
  });

  it("asOf reports the newest PERIOD END, not the request clock — no overstated freshness", async () => {
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2026-06-01");
    expect(f.asOf).toBe("2025-09-27");
  });

  it("prefers the latest filing for a period (restatements known at the clock)", async () => {
    const restated = facts({
      EarningsPerShareDiluted: {
        units: {
          "USD/shares": [
            flow("2024-09-28", 6.08, "2024-11-01"),
            flow("2025-09-27", 7.46, "2025-10-31"),
            { ...flow("2025-09-27", 7.1, "2026-02-01"), form: "10-K/A" }, // later restatement
          ],
        },
      },
    });
    const before = await adapter(makeFetch(restated)).getFundamentals("AAPL", "2026-01-01");
    const after = await adapter(makeFetch(restated)).getFundamentals("AAPL", "2026-03-01");
    expect(before.epsGrowthPct).toBeCloseTo(((7.46 - 6.08) / 6.08) * 100, 4); // original
    expect(after.epsGrowthPct).toBeCloseTo(((7.1 - 6.08) / 6.08) * 100, 4); // restated
  });

  it("leaves price-dependent fields null without a market-data source, rather than guessing", async () => {
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2026-01-01");
    expect(f.peRatio).toBeNull();
    expect(f.marketCapUsd).toBeNull();
  });

  it("computes PE and market cap when a price source is injected", async () => {
    const marketData = { getLatestPrice: async () => 250, getBars: async () => [] };
    const f = await adapter(makeFetch(facts()), marketData).getFundamentals("AAPL", "2026-01-01");
    expect(f.peRatio).toBeCloseTo(250 / 7.46, 6);
    expect(f.marketCapUsd).toBeCloseTo(250 * 15_000_000_000, 0);
  });

  it("computes EBIT/EV from operating income, market cap, debt and cash", async () => {
    const marketData = { getLatestPrice: async () => 250, getBars: async () => [] };
    const withEbit = facts({ OperatingIncomeLoss: { units: { USD: [flow("2025-09-27", 133_000_000_000, "2025-10-31")] } } });
    const f = await adapter(makeFetch(withEbit), marketData).getFundamentals("AAPL", "2026-01-01");
    // EV = 3.75T market cap + 80B debt - 30B cash
    expect(f.ebitToEv).toBeCloseTo(133e9 / (250 * 15e9 + 80e9 - 30e9), 9);
    expect((await adapter(makeFetch(facts()), marketData).getFundamentals("AAPL", "2026-01-01")).ebitToEv).toBeNull();
    expect((await adapter(makeFetch(withEbit)).getFundamentals("AAPL", "2026-01-01")).ebitToEv).toBeNull();
    // No operating-income line (XOM): pre-tax income + interest expense.
    const pretax = facts({
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: { units: { USD: [flow("2025-09-27", 120_000_000_000, "2025-10-31")] } },
      InterestExpense: { units: { USD: [flow("2025-09-27", 4_000_000_000, "2025-10-31")] } },
    });
    expect((await adapter(makeFetch(pretax), marketData).getFundamentals("AAPL", "2026-01-01")).ebitToEv).toBeCloseTo(124e9 / (250 * 15e9 + 80e9 - 30e9), 9);
  });

  it("derives 12-month price change and P/E vs own history from a split-adjusted price source", async () => {
    // EPS 6.13 / 6.08 / 7.46 at FY ends 2023-09-30, 2024-09-28, 2025-09-27 (fixture); raw price 250 now.
    const split: Record<string, number> = { "2023-09-30": 100, "2024-09-28": 150, "2025-09-27": 200, "2024-12-31": 160, "2026-01-01": 200 };
    const historyPrices = { getLatestPrice: async (_s: string, at?: string) => split[at!.slice(0, 10)] ?? 0, getBars: async () => [] };
    const marketData = { getLatestPrice: async () => 250, getBars: async () => [] };
    const f = await new SecEdgarFundamentals({ userAgent: "test", fetchImpl: makeFetch(facts()), marketData, historyPrices } as never).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
    expect(f.priceChange12mPct).toBeCloseTo((200 / 160 - 1) * 100, 6);
    expect(f.epsChangePct).toBeCloseTo((7.46 / 6.08 - 1) * 100, 6);
    const peNow = 250 / 7.46;
    const pes = [[100, 6.13], [150, 6.08], [200, 7.46]].map(([p, e]) => (peNow * (p! / 200)) / (e! / 7.46));
    expect(f.fiveYearAvgPe).toBeCloseTo(pes.reduce((a, b) => a + b, 0) / 3, 6);
  });

  it("survives a price-source outage — fundamentals still return", async () => {
    const marketData = {
      getLatestPrice: async () => {
        throw new Error("alpaca down");
      },
      getBars: async () => [],
    };
    const f = await adapter(makeFetch(facts()), marketData).getFundamentals("AAPL", "2026-01-01");
    expect(f.peRatio).toBeNull();
    expect(f.epsGrowthPct).not.toBeNull(); // core data unaffected
  });

  it("nulls fields it genuinely cannot know instead of inventing them", async () => {
    const f = await adapter(makeFetch(facts())).getFundamentals("AAPL", "2026-01-01");
    expect(f.institutionalOwnershipPct).toBeNull();
    expect(f.insiderNetBuying).toBeNull();
    expect(f.earningsCyclicality).toBeNull();
  });

  it("rejects non-US filers clearly (EDGAR has no CIK for them)", async () => {
    await expect(adapter(makeFetch(facts())).getFundamentals("VOD.L", "2026-01-01")).rejects.toThrow(
      /no CIK/i,
    );
  });

  it("caps history to the trailing window so pre-split filings cannot corrupt growth", async () => {
    // Real-world case: AAPL FY2009 EPS is on record as 9.08 (pre 7:1 and 4:1 splits) vs 7.46 for
    // FY2025. Including it would report a fictitious collapse.
    const long = facts({
      EarningsPerShareDiluted: {
        units: {
          "USD/shares": [
            flow("2009-09-26", 9.08, "2009-11-01"), // pre-split — must be excluded
            flow("2021-09-25", 5.61, "2021-10-29"),
            flow("2022-09-24", 6.11, "2022-10-28"),
            flow("2023-09-30", 6.13, "2023-11-03"),
            flow("2024-09-28", 6.08, "2024-11-01"),
            flow("2025-09-27", 7.46, "2025-10-31"),
          ],
        },
      },
    });
    const f = await adapter(makeFetch(long)).getFundamentals("AAPL", "2026-01-01");
    expect(f.epsGrowthHistoryPct).toHaveLength(4); // 5 periods -> 4 YoY steps
    // No entry may reflect the pre-split cliff (~ -38% from 9.08 to 5.61).
    expect(Math.min(...f.epsGrowthHistoryPct)).toBeGreaterThan(-20);
  });

  it("honours an explicit historyYears window", async () => {
    const f = await new SecEdgarFundamentals({
      userAgent: "t t@e.com",
      historyYears: 2,
      fetchImpl: makeFetch(facts()) as unknown as typeof fetch,
    }).getFundamentals("AAPL", "2026-01-01");
    expect(f.epsGrowthHistoryPct).toHaveLength(1); // 2 periods -> 1 step
  });

  it("fetches companyfacts ONCE across many point-in-time clocks (backtest cost)", async () => {
    // The payload carries the whole history and the point-in-time cut is local, so a backtest
    // sweeping 12 rebalance dates must not re-download ~3.5 MB twelve times.
    const fetchImpl = makeFetch(facts());
    const fd = adapter(fetchImpl);
    for (const clock of ["2024-01-01", "2024-06-01", "2025-01-01", "2025-11-01", "2026-01-01"]) {
      await fd.getFundamentals("AAPL", clock);
    }
    const factsCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("companyfacts"));
    const tickerCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("company_tickers"));
    expect(factsCalls).toHaveLength(1);
    expect(tickerCalls).toHaveLength(1);
  });

  it("still returns clock-correct results when served from cache", async () => {
    const fd = adapter(makeFetch(facts()));
    const early = await fd.getFundamentals("AAPL", "2025-10-01"); // pre-FY2025 filing
    const late = await fd.getFundamentals("AAPL", "2025-11-01"); // post-filing, cached payload
    expect(early.asOf).toBe("2024-09-28");
    expect(late.asOf).toBe("2025-09-27");
  });

  it("falls back through concept aliases when the preferred tag is absent", async () => {
    const alt = facts({
      Revenues: undefined,
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [flow("2024-09-28", 100, "2024-11-01"), flow("2025-09-27", 150, "2025-10-31")] },
      },
    });
    const f = await adapter(makeFetch(alt)).getFundamentals("AAPL", "2026-01-01");
    expect(f.revenueGrowthPct).toBeCloseTo(50, 6);
  });

  describe("SIC code — the sector source for the D/E gate and the concentration cap", () => {
    /** Serves the submissions document separately from companyfacts, as data.sec.gov does. */
    const withSubmissions = (submissions: unknown, status = 200) =>
      vi.fn(async (url: string) => {
        const u = String(url);
        const payload = u.includes("company_tickers") ? TICKERS : u.includes("/submissions/") ? submissions : facts();
        return new Response(JSON.stringify(payload), {
          status: u.includes("/submissions/") ? status : 200,
          headers: { "content-type": "application/json" },
        });
      });

    it("reads sic from the submissions document for the SAME CIK", async () => {
      const fetchImpl = withSubmissions({ sic: "3571", sicDescription: "Electronic Computers" });
      const f = await adapter(fetchImpl as never).getFundamentals("AAPL", "2026-01-01");
      expect(f.sicCode).toBe("3571");
      expect(fetchImpl.mock.calls.map(([u]) => String(u))).toContainEqual(
        expect.stringContaining("/submissions/CIK0000320193.json"),
      );
    });

    it("normalises the numeric form EDGAR sometimes returns", async () => {
      const f = await adapter(withSubmissions({ sic: 6021 }) as never).getFundamentals("AAPL", "2026-01-01");
      expect(f.sicCode).toBe("6021");
    });

    it("degrades to null instead of failing the whole fundamentals call", async () => {
      // SIC only scopes a gate and feeds a cap; both degrade safely to "unclassified". Failing the
      // fundamentals fetch over it would take out the entire screen for a cosmetic field.
      const f = await adapter(withSubmissions({}, 404) as never).getFundamentals("AAPL", "2026-01-01");
      expect(f.sicCode).toBeNull();
      expect(f.debtToEquity).not.toBeNull(); // the real payload still came through
    });

    it("is null when the document omits sic entirely", async () => {
      const f = await adapter(withSubmissions({ name: "Apple Inc." }) as never).getFundamentals("AAPL", "2026-01-01");
      expect(f.sicCode).toBeNull();
    });

    it("fetches submissions ONCE per company across repeated point-in-time cuts", async () => {
      // A monthly 10-year run asks for the same company ~120 times. Without memoisation that is
      // 120 extra requests per name against a ~10 req/s limit.
      const fetchImpl = withSubmissions({ sic: "3571" });
      const fd = adapter(fetchImpl as never);
      await fd.getFundamentals("AAPL", "2024-01-01");
      await fd.getFundamentals("AAPL", "2025-01-01");
      const subCalls = fetchImpl.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/submissions/"));
      expect(subCalls).toHaveLength(1);
    });

    it("exposes getSicCode so a harness can prefetch a sector map", async () => {
      // RunDeps.sectorOf is synchronous, so the map must be built before the run starts.
      expect(await adapter(withSubmissions({ sic: "6021" }) as never).getSicCode("AAPL")).toBe("6021");
    });
  });

  describe("cikOverrides — reaching delisted filers", () => {
    // company_tickers.json is CURRENT-STATE ONLY. Every delisted company is missing from it, so a
    // survivorship-controlled backtest silently skipped exactly the names that failed (SIVB, FRC,
    // ATVI) even though EDGAR still holds their filings.
    it("resolves a ticker absent from the current map", async () => {
      const fetchImpl = makeFetch(facts());
      const fd = new SecEdgarFundamentals({
        userAgent: "test test@example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cikOverrides: { SIVB: 719739 }, // SVB Financial Group
      });
      await fd.getFundamentals("SIVB", "2026-01-01");
      const factsUrl = fetchImpl.mock.calls.map(([u]) => String(u)).find((u) => u.includes("companyfacts"));
      expect(factsUrl).toContain("CIK0000719739"); // numeric override zero-padded to 10
    });

    it("lets the CURRENT map win, so a recycled ticker cannot shadow a live company", async () => {
      // A dead company's symbol can be reissued to a new one. Overrides are a fallback, never a
      // preference — otherwise a stale historical mapping would hijack a name that still trades.
      const fetchImpl = makeFetch(facts());
      const fd = new SecEdgarFundamentals({
        userAgent: "test test@example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cikOverrides: { AAPL: 111111 }, // must be IGNORED — AAPL is in the current map
      });
      await fd.getFundamentals("AAPL", "2026-01-01");
      const factsUrl = fetchImpl.mock.calls.map(([u]) => String(u)).find((u) => u.includes("companyfacts"));
      expect(factsUrl).toContain("CIK0000320193"); // the real Apple CIK, not the override
    });

    it("resolves dotted class-share tickers via SEC's dashed form (BRK.B -> BRK-B)", async () => {
      // Alpaca and the membership history say BRK.B; company_tickers.json says BRK-B. Before this,
      // BRK.B and BF.B priced every month but were never screened.
      const fetchImpl = makeFetch(facts(), { "0": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" } });
      await adapter(fetchImpl).getFundamentals("BRK.B", "2026-01-01");
      const factsUrl = fetchImpl.mock.calls.map(([u]) => String(u)).find((u) => u.includes("companyfacts"));
      expect(factsUrl).toContain("CIK0001067983");
    });

    it("counts officer/director purchases filed in the 180 days BEFORE the clock date", async () => {
      const fd = new SecEdgarFundamentals({
        userAgent: "test test@example.com",
        fetchImpl: makeFetch(facts()) as unknown as typeof fetch,
        insiderPurchases: {
          "0000320193": [
            ["2025-06-30", 1], // > 180 days before: out
            ["2025-08-01", 1], // in
            ["2025-12-31", 1], // in
            ["2026-01-01", 1], // the clock date itself: out (may land after the decision)
          ],
        },
      });
      expect((await fd.getFundamentals("AAPL", "2026-01-01T00:00:00Z")).insiderPurchases180d).toBe(2);
      expect((await adapter(makeFetch(facts())).getFundamentals("AAPL", "2026-01-01T00:00:00Z")).insiderPurchases180d).toBeUndefined();
    });

    it("never prices BRK.B off Class A per-share facts (P/E would read ~1,500x too cheap)", async () => {
      const marketData = { getLatestPrice: async () => 330, getBars: async () => [] };
      const brk = { "0": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" } };
      const f = await adapter(makeFetch(facts(), brk), marketData).getFundamentals("BRK.B", "2026-01-01");
      expect(f.peRatio).toBeNull();
      expect(f.marketCapUsd).toBeNull();
      expect(f.epsGrowthPct).not.toBeNull(); // ratio-free fields survive
      expect((await adapter(makeFetch(facts()), marketData).getFundamentals("AAPL", "2026-01-01")).peRatio).not.toBeNull();
    });

    it("explains WHY a ticker is unresolvable rather than just failing", async () => {
      // The old message ("US filers only") sent us looking for a coverage problem when the real
      // cause was that the map omits delisted names. That misdirection cost a debugging cycle.
      await expect(adapter(makeFetch(facts())).getFundamentals("SIVB", "2026-01-01")).rejects.toThrow(
        /CURRENT-STATE ONLY|cikOverrides/,
      );
    });
  });

  // --- 2026-09-16 audit against live companyfacts (QCOM, V, XOM, INTC, BA, JNJ, AAPL) ---
  describe("stale and mixed-period values", () => {
    it("merges concept aliases by period instead of reporting a tag the filer abandoned years ago (QCOM)", async () => {
      const f = await adapter(
        makeFetch(
          facts({
            StockholdersEquity: { units: { USD: [point("2019-09-29", 4_909_000_000, "2019-11-06")] } },
            StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: {
              units: { USD: [point("2025-09-27", 21_206_000_000, "2025-10-31")] },
            },
          }),
        ),
      ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
      expect(f.debtToEquity).toBeCloseTo(80_000_000_000 / 21_206_000_000, 6);
    });

    it("does not double count current debt when only the total LongTermDebt is tagged", async () => {
      const f = await adapter(
        makeFetch(
          facts({
            LongTermDebtNoncurrent: undefined,
            LongTermDebt: { units: { USD: [point("2025-09-27", 24_070_000_000, "2025-10-31")] } },
            LongTermDebtCurrent: { units: { USD: [point("2025-09-27", 2_999_000_000, "2025-10-31")] } },
          }),
        ),
      ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
      expect(f.debtToEquity).toBeCloseTo(24_070_000_000 / 56_950_000_000, 6);
    });

    it("counts commercial paper as debt", async () => {
      const f = await adapter(
        makeFetch(facts({ CommercialPaper: { units: { USD: [point("2025-09-27", 8_000_000_000, "2025-10-31")] } } })),
      ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
      expect(f.debtToEquity).toBeCloseTo(88_000_000_000 / 56_950_000_000, 6);
    });

    it("reads a suspended dividend as zero, not the last dividend ever declared (BA)", async () => {
      const f = await adapter(
        makeFetch(
          facts({
            CommonStockDividendsPerShareDeclared: { units: { "USD/shares": [flow("2019-12-31", 8.22, "2020-01-31")] } },
          }),
        ),
        { getLatestPrice: async () => 200, getBars: async () => [] },
      ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
      expect(f.dividendYieldPct).toBe(0);
    });

    it("never computes growth from a loss (INTC -4.38 -> -0.06 is not +98.6%)", async () => {
      const f = await adapter(
        makeFetch(
          facts({
            EarningsPerShareDiluted: {
              units: { "USD/shares": [flow("2024-09-28", -4.38, "2024-11-01"), flow("2025-09-27", -0.06, "2025-10-31")] },
            },
          }),
        ),
      ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
      expect(f.epsGrowthPct).toBeNull();
      expect(f.epsGrowthHistoryPct).toEqual([]);
    });

    it("uses the multi-year rate so one noisy year cannot make a fast grower (JNJ)", async () => {
      const series = [["2021-12-31", 7.81], ["2022-12-31", 6.73], ["2023-12-31", 13.72], ["2024-12-31", 5.79], ["2025-12-31", 11.03]] as const;
      const f = await adapter(
        makeFetch(
          facts({
            EarningsPerShareDiluted: { units: { "USD/shares": series.map(([end, v]) => flow(end, v, `${Number(end.slice(0, 4)) + 1}-02-15`)) } },
            NetIncomeLoss: { units: { USD: [flow("2025-12-31", 26_000_000_000, "2026-02-15")] } },
          }),
        ),
      ).getFundamentals("AAPL", "2026-03-01T00:00:00Z");
      expect(f.epsGrowthPct).toBeCloseTo(((11.03 / 7.81) ** (1 / 4) - 1) * 100, 4); // ~9%, not +90.5%
      expect(f.epsGrowthHistoryPct.at(-1)).toBeCloseTo(90.5, 1); // the one-year jump stays visible
    });

    it("reads a predecessor CIK when the current filer has no annual history yet (XOM reorganisation)", async () => {
      const tickers = { "0": { cik_str: 2115436, ticker: "XOM", title: "ExxonMobil Holdings Corp" } };
      const fetchImpl = vi.fn(async (url: string) => {
        const u = String(url);
        const payload = u.includes("company_tickers")
          ? tickers
          : u.includes("CIK0002115436")
            ? { facts: { "us-gaap": { NetIncomeLoss: { units: { USD: [] } } } } }
            : facts();
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      });
      const f = await adapter(fetchImpl as never).getFundamentals("XOM", "2026-01-01T00:00:00Z");
      expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("CIK0000034088"))).toBe(true);
      expect(f.debtToEquity).not.toBeNull();
    });
  });

  it("puts pre-split EPS on the current share basis before computing growth (NVDA 10:1)", async () => {
    const eps = [["2022-01-30", 3.85], ["2023-01-29", 1.74], ["2024-01-28", 11.93], ["2025-01-26", 2.94], ["2026-01-25", 4.9]] as const;
    const shares = [["2022-01-30", 2_535e6], ["2023-01-29", 2_507e6], ["2024-01-28", 2_494e6], ["2025-01-26", 24_804e6], ["2026-01-25", 24_600e6]] as const;
    const f = await adapter(
      makeFetch(
        facts({
          EarningsPerShareDiluted: { units: { "USD/shares": eps.map(([end, v]) => flow(end, v, "2026-02-26")) } },
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: shares.map(([end, v]) => flow(end, v, "2026-02-26")) } },
          NetIncomeLoss: { units: { USD: [flow("2026-01-25", 120e9, "2026-02-26")] } },
        }),
      ),
    ).getFundamentals("AAPL", "2026-03-01T00:00:00Z");
    // 0.385 -> 4.90 over 4 years, not 3.85 -> 4.90
    expect(f.epsGrowthPct).toBeCloseTo(((4.9 / 0.385) ** (1 / 4) - 1) * 100, 3);
    expect(Math.min(...f.epsGrowthHistoryPct)).toBeGreaterThan(-60); // no fake -75% "collapse" at the split
  });

  it("computes Piotroski F_SCORE from three fiscal years of filings", async () => {
    const yrs = ["2023-09-30", "2024-09-28", "2025-09-27"];
    const f = await adapter(
      makeFetch(
        facts({
          Assets: { units: { USD: yrs.map((e, i) => point(e, [300e9, 330e9, 360e9][i]!, "2025-10-31")) } },
          NetIncomeLoss: { units: { USD: yrs.map((e, i) => flow(e, [90e9, 95e9, 112e9][i]!, "2025-10-31")) } },
          NetCashProvidedByUsedInOperatingActivities: { units: { USD: yrs.map((e, i) => flow(e, [100e9, 110e9, 125e9][i]!, "2025-10-31")) } },
          Revenues: { units: { USD: yrs.map((e, i) => flow(e, [380e9, 391e9, 416e9][i]!, "2025-10-31")) } },
          GrossProfit: { units: { USD: yrs.map((e, i) => flow(e, [170e9, 180e9, 195e9][i]!, "2025-10-31")) } },
          AssetsCurrent: { units: { USD: yrs.map((e, i) => point(e, [140e9, 150e9, 170e9][i]!, "2025-10-31")) } },
          LiabilitiesCurrent: { units: { USD: yrs.map((e) => point(e, 120e9, "2025-10-31")) } },
          LongTermDebtNoncurrent: { units: { USD: yrs.map((e, i) => point(e, [95e9, 85e9, 80e9][i]!, "2025-10-31")) } },
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: yrs.map((e, i) => flow(e, [15.8e9, 15.4e9, 15e9][i]!, "2025-10-31")) } },
        }),
      ),
    ).getFundamentals("AAPL", "2026-01-01T00:00:00Z");
    expect(f.piotroski?.computable).toBe(9);
    // ROA+, CFO+, ΔROA (112/330 > 95/300), accrual (125 > 112), leverage down, liquidity up, no issuance,
    // margin up (46.9% vs 46.0%), turnover (416/330=1.26 > 391/300=1.30? no) -> 8
    expect(f.piotroski?.signals.deltaTurn).toBe(0);
    expect(f.piotroski?.score).toBe(8);
  });
});
