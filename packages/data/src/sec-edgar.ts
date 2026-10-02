/**
 * SEC EDGAR XBRL fundamentals adapter — free, keyless, and sourced from the regulator's own
 * filing system rather than a third-party aggregator.
 *
 * WHY THIS EXISTS ALONGSIDE financialdatasets.ai: EDGAR publishes the actual `filed` date on
 * every datapoint. Aggregators generally expose only the fiscal `report_period`, which forces
 * a *guess* at publication lag (we use 90 days there — see FinancialDatasetsOptions). With the
 * real filing date the point-in-time cutoff becomes EXACT: a backtest sees a figure on the day
 * the market saw it, not a conservative approximation. That removes a whole class of
 * look-ahead error from backtests.
 *
 * TRADE-OFF: EDGAR serves raw XBRL concepts, not computed ratios. PE, PEG, D/E, ROE and margins
 * are derived here. Price-dependent fields (peRatio, marketCapUsd) need a price, so a
 * MarketDataAdapter must be injected — without one they are left null rather than guessed.
 *
 * LIMITATIONS (be explicit, these matter for coverage):
 *  - US filers only. UK/EU listings are not in EDGAR — a UK leg needs another source.
 *  - Filers tag the same idea with different us-gaap concepts, so extraction tries a list of
 *    aliases per field and takes the first that resolves. Unmapped filers yield nulls, never
 *    wrong numbers.
 *  - SEC requires a descriptive User-Agent and rate-limits to ~10 req/s.
 */
import { piotroskiFScore, type Fundamentals, type PiotroskiYear } from "@dipbuyer/shared";
import type { FundamentalsAdapter, MarketDataAdapter } from "./index.js";
import { withCache, withRetry, type CacheOptions, type RetryOptions } from "./http.js";

export interface SecEdgarOptions {
  /**
   * SEC requires a descriptive User-Agent identifying the caller (name + contact).
   * Requests without one are refused.
   */
  userAgent: string;
  /** Optional price source for peRatio / marketCapUsd. Omitted => those stay null. */
  marketData?: MarketDataAdapter;
  /**
   * Optional SPLIT-adjusted price source for price history: 12-month price change and the P/E the
   * stock traded at over its trailing fiscal years (`fiveYearAvgPe`). Omitted => those stay null.
   * Split-adjusted, not total-return: dividend back-adjustment would lower past prices by the
   * cumulative yield and make every dividend payer look expensive against its own history.
   */
  historyPrices?: MarketDataAdapter;
  /**
   * How many trailing annual periods to consider (default 5).
   *
   * This is a CORRECTNESS bound, not a performance one. EDGAR serves as-filed values, which are
   * NOT split-adjusted across filings: Apple's FY2009 EPS is on record as 9.08 (pre the 2014 7:1
   * and 2020 4:1 splits) against 7.46 for FY2025. Computing year-on-year growth across a split
   * yields garbage — a verified -77% "collapse" that was actually a 7:1 split. The most recent
   * filings restate their own comparative years on a consistent basis, so a short trailing window
   * stays internally coherent.
   *
   * Residual risk: a split INSIDE the window can still distort one step. Widen only if you have
   * split-adjusted inputs.
   */
  historyYears?: number;
  /**
   * Supplementary ticker -> CIK map, consulted only when `company_tickers.json` has no entry.
   *
   * That file is CURRENT-STATE ONLY: every delisted company is absent from it, so SIVB, FRC and
   * ATVI all fail to resolve even though their filings are still on EDGAR and their prices are
   * still served by Alpaca. In a survivorship-controlled backtest that silently excludes exactly
   * the companies the point-in-time universe exists to include.
   *
   * ⚠️ TICKER REUSE: a symbol can be recycled by a different company after a delisting. Entries
   * here are only reached when the ticker is absent from the current map, so a live company is
   * never shadowed — but a historical mapping is only correct for the era it came from. Keep
   * overrides for genuinely retired tickers.
   */
  cikOverrides?: Record<string, string | number>;
  /**
   * Predecessor CIKs to read when the CURRENT CIK has no annual 10-K facts yet — e.g. after a
   * holding-company reorganisation. company_tickers.json moved XOM to "ExxonMobil Holdings Corp"
   * (CIK 2115436), which by 2026-09 had filed one 10-Q and no 10-K, so every field came back null
   * while the full history sat under the old CIK 34088. Merged over DEFAULT_CIK_FALLBACKS.
   */
  cikFallbacks?: Record<string, Array<string | number>>;
  /**
   * Officer/director open-market purchases by issuer CIK: [filing date YYYY-MM-DD, usd][], from
   * SEC's Form 3/4/5 data sets (apps/api/scripts/build-insider-index.mjs). When given, sets
   * `insiderPurchases180d`. Omit and the field stays undefined.
   */
  insiderPurchases?: Record<string, Array<[string, number]>>;
  baseUrl?: string;
  tickersUrl?: string;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  /**
   * Response cache. ESSENTIAL for backtests, not an optimisation.
   *
   * A companyfacts payload is ~3.5 MB and contains the company's ENTIRE filing history; the
   * point-in-time cut happens locally on `filed`. So one fetch per symbol serves every
   * rebalance date. Uncached, a 10-symbol × 12-month backtest would pull ~420 MB and breach
   * SEC's ~10 req/s limit; cached it is 10 requests.
   *
   * Default TTL is 6h — filings are published quarterly, so staleness risk is negligible and
   * a long TTL is what makes repeated backtests cheap. Pass a shared `cache` (e.g. Redis-backed)
   * to reuse across processes.
   */
  cache?: CacheOptions;
}

/**
 * Traded class-share tickers whose EDGAR per-share facts are stated for another class. Berkshire
 * reports EPS and shares per CLASS A share; one A = 1,500 B, so a BRK.B P/E built from them reads
 * ~1,500x too cheap. Today BRK.B abstains anyway (no EarningsPerShareDiluted tag), but any new EPS
 * alias would turn it into a permanent top-conviction "buy". BF.B is fine: Brown-Forman reports
 * per share of Class A and B combined, which trade at similar prices.
 */
const PER_SHARE_CLASS_MISMATCH = new Set(["BRK.B"]);

/** Filings change quarterly at most, so a long default TTL is safe and makes backtests cheap. */
const DEFAULT_EDGAR_TTL_MS = 6 * 60 * 60 * 1000;

/** One XBRL datapoint as EDGAR returns it. */
interface Fact {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed: string;
}

interface CompanyFacts {
  entityName?: string;
  facts?: { "us-gaap"?: Record<string, { units?: Record<string, Fact[]> }> };
}

/**
 * Concept aliases, most-preferred first. Filers differ: post-ASC-606 registrants use
 * RevenueFromContractWithCustomer…, older ones plain Revenues.
 */
const CONCEPTS = {
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"],
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  liabilities: ["Liabilities"],
  assetsCurrent: ["AssetsCurrent"],
  liabilitiesCurrent: ["LiabilitiesCurrent"],
  inventory: ["InventoryNet"],
  cash: ["CashAndCashEquivalentsAtCarryingValue"],
  shortTermInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
  // Debt is assembled per period in totalDebtAt(); see there for why these are separate.
  debtCurrent: ["DebtCurrent"],
  longTermDebtCurrent: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
  commercialPaper: ["CommercialPaper"],
  shortTermBorrowings: ["ShortTermBorrowings"],
  longTermDebtNoncurrent: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  longTermDebtTotal: ["LongTermDebt"],
  sharesDiluted: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  assets: ["Assets"],
  grossProfit: ["GrossProfit"],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  sharesOutstanding: ["CommonStockSharesOutstanding"],
  dividendsPerShare: ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment"],
  operatingIncome: ["OperatingIncomeLoss"],
  // EBIT fallback for filers with no operating-income line (XOM, CVX): pre-tax income + interest.
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  interestExpense: ["InterestExpense", "InterestExpenseDebt", "InterestExpenseNonoperating"],
} as const;

/** Default predecessor CIKs; see SecEdgarOptions.cikFallbacks. */
const DEFAULT_CIK_FALLBACKS: Record<string, Array<string | number>> = { XOM: [34088] };

/**
 * Percentage change. Undefined unless the base is POSITIVE: growth "from" a loss has no meaning,
 * and dividing by |prev| produced INTC -4.38 -> -0.06 as "+98.6% growth" and BA -18.36 -> 2.48 as
 * +113.5%, which classified loss-makers as fast growers.
 */
const pct = (cur: number, prev: number): number | null =>
  !Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0 ? null : ((cur - prev) / prev) * 100;

const YEAR_MS = 365.25 * 86_400_000;

/**
 * Annualised EPS growth across the whole trailing window, both ends positive. Lynch's growth rate
 * is a multi-year rate; one year is noise. JNJ FY2024 5.79 -> FY2025 11.03 read "+90.5%, fast
 * grower" while its 4-year rate was ~9%. Two periods reduce to the one-year change.
 */
function epsCagr(eps: Array<{ end: string; val: number }>): number | null {
  if (eps.length < 2) return null;
  const first = eps[0]!;
  const last = eps[eps.length - 1]!;
  if (first.val <= 0 || last.val <= 0) return null;
  const years = Math.round((Date.parse(last.end) - Date.parse(first.end)) / YEAR_MS);
  if (years < 1) return null;
  return ((last.val / first.val) ** (1 / years) - 1) * 100;
}

const SPLIT_FACTORS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50];

/**
 * Put as-filed EPS on the latest share basis. EDGAR keeps each period's value from its latest
 * filing, and periods older than the newest 10-K's comparatives predate later splits: NVDA's FY2022
 * EPS is on record pre-10:1, so a 4-year growth rate read ~6% and the engine said "sell".
 *
 * A split shows as a jump in diluted weighted shares that sits within 6% of a standard split
 * factor (forward or reverse). Buybacks never do that; a share-issuing merger almost never lands
 * on an exact factor. EPS before the jump is divided by the factor.
 */
export function splitAdjustEps(
  eps: Array<{ end: string; val: number }>,
  shares: Array<{ end: string; val: number }>,
): Array<{ end: string; val: number }> {
  const sharesAt = (end: string) => shares.find((x) => Math.abs(Date.parse(x.end) - Date.parse(end)) <= 10 * 86_400_000)?.val;
  const out = eps.map((e) => ({ end: e.end, val: e.val }));
  for (let i = out.length - 1; i > 0; i--) {
    const cur = sharesAt(out[i]!.end);
    const prev = sharesAt(out[i - 1]!.end);
    if (!cur || !prev || cur <= 0 || prev <= 0) continue;
    const r = cur / prev;
    const forward = SPLIT_FACTORS.find((k) => Math.abs(r / k - 1) <= 0.06);
    const reverse = SPLIT_FACTORS.find((k) => Math.abs(r * k - 1) <= 0.06);
    const factor = forward ?? (reverse ? 1 / reverse : null);
    if (!factor) continue;
    for (let j = 0; j < i; j++) out[j]!.val = out[j]!.val / factor;
  }
  return out;
}

/** Period ends within this many days are the same fiscal year (52/53-week calendars drift). */
const SAME_PERIOD_DAYS = 10;

const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

export class SecEdgarFundamentals implements FundamentalsAdapter {
  readonly sourceId = "sec-edgar";
  private readonly baseUrl: string;
  private readonly tickersUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cikCache: Map<string, string> | null = null;
  private readonly sicCache = new Map<string, string | null>();

  constructor(private readonly opts: SecEdgarOptions) {
    this.baseUrl = opts.baseUrl ?? "https://data.sec.gov";
    this.tickersUrl = opts.tickersUrl ?? "https://www.sec.gov/files/company_tickers.json";
    // Cache OUTSIDE retry: a cache hit should not consume a retry budget, and a retried
    // request should still populate the cache once it succeeds.
    this.fetchImpl = withCache(withRetry(opts.fetchImpl ?? fetch, { alsoRetry: [403], ...opts.retry }), {
      ttlMs: DEFAULT_EDGAR_TTL_MS,
      ...opts.cache,
    });
  }

  private headers(): Record<string, string> {
    return { "User-Agent": this.opts.userAgent, Accept: "application/json" };
  }

  /** ticker -> zero-padded CIK. Fetched once and memoised (the file is ~10k entries). */
  private async cikFor(symbol: string): Promise<string> {
    if (!this.cikCache) {
      const res = await this.fetchImpl(this.tickersUrl, { headers: this.headers() });
      if (!res.ok) throw new Error(`sec-edgar tickers: HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
      this.cikCache = new Map(
        Object.values(body).map((e) => [e.ticker.toUpperCase(), String(e.cik_str).padStart(10, "0")]),
      );
    }
    const upper = symbol.toUpperCase();
    // CURRENT map first, overrides second. company_tickers.json is authoritative for anything
    // still trading; overrides exist to cover names it CANNOT know about — delisted filers, which
    // it drops entirely. Preferring overrides would risk shadowing a live company whose ticker was
    // recycled from a dead one.
    // Class-share tickers are dotted at exchanges and Alpaca (BRK.B, BF.B) but dashed in SEC's map
    // (BRK-B). Without this every dotted S&P 500 member priced but never screened.
    const cik =
      this.cikCache.get(upper) ?? this.cikCache.get(upper.replace(/\./g, "-")) ?? this.opts.cikOverrides?.[upper];
    if (!cik) {
      throw new Error(
        `sec-edgar: no CIK for ${symbol} (US filers only). company_tickers.json is CURRENT-STATE ` +
          `ONLY, so delisted companies are absent from it — supply cikOverrides to reach them, or ` +
          `backtests will silently skip exactly the names that failed.`,
      );
    }
    return String(cik).padStart(10, "0");
  }

  /**
   * SIC code from the submissions document. BEST-EFFORT: an outage here must not fail the whole
   * fundamentals call, because SIC only scopes the D/E gate and feeds the concentration cap —
   * both degrade to "unclassified", which is the same state every non-EDGAR source is in.
   *
   * Memoised per CIK on top of the HTTP cache so a universe sweep costs one request per company.
   */
  private async sicFor(cik: string): Promise<string | null> {
    const cached = this.sicCache.get(cik);
    if (cached !== undefined) return cached;
    let sic: string | null = null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/submissions/CIK${cik}.json`, {
        headers: this.headers(),
      });
      if (res.ok) {
        const body = (await res.json()) as { sic?: string | number | null };
        const raw = body.sic;
        sic = raw === null || raw === undefined || raw === "" ? null : String(raw);
      }
    } catch {
      sic = null;
    }
    this.sicCache.set(cik, sic);
    return sic;
  }

  /**
   * Public so a harness can PREFETCH sectors for a universe before a run. `RunDeps.sectorOf` is
   * synchronous, so the map has to exist before the first buy — deriving it lazily during
   * screening would leave the earliest names unclassified and the cap silently partial.
   */
  async getSicCode(symbol: string): Promise<string | null> {
    return this.sicFor(await this.cikFor(symbol));
  }

  /**
   * Annual datapoints for the first concept alias that resolves, POINT-IN-TIME filtered.
   *
   * Two things make this correct:
   *  1. `filed <= asOf` — the market could not have seen a filing before it was filed.
   *  2. dedupe by period `end`, keeping the LATEST filing that satisfies (1). A 10-K restates
   *     prior years, so this reflects what was known at the clock, restatements included.
   * Returned oldest -> newest.
   */
  private annual(
    gaap: Record<string, { units?: Record<string, Fact[]> }>,
    aliases: readonly string[],
    asOf: string,
    opts: { duration: boolean },
  ): Fact[] {
    const cutoff = asOf.slice(0, 10);
    // MERGE aliases per period, preferred alias first. Taking the first alias with ANY facts was
    // wrong whenever a filer changed tags: that alias's last value could be years old and was then
    // reported as current (QCOM equity from 2019, V equity from 2011, XOM debt from 2017).
    const byEnd = new Map<string, Fact>();
    for (const name of aliases) {
      const units = gaap[name]?.units;
      if (!units) continue;
      const perAlias = new Map<string, Fact>();
      for (const f of Object.values(units).flat()) {
        if (!f.filed || f.filed > cutoff) continue; // POINT-IN-TIME
        if (f.form !== "10-K" && f.form !== "10-K/A") continue;
        if (f.fp !== "FY") continue;
        if (opts.duration) {
          // Income/cash-flow items: keep ~annual spans, excluding quarterly slices.
          if (!f.start) continue;
          const days = (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
          if (days < 300 || days > 400) continue;
        }
        const prev = perAlias.get(f.end);
        if (!prev || f.filed > prev.filed) perAlias.set(f.end, f);
      }
      for (const [periodEnd, f] of perAlias) if (!byEnd.has(periodEnd)) byEnd.set(periodEnd, f);
    }
    const sorted = [...byEnd.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
    // Trailing window only — older periods come from older filings whose share-based figures
    // predate later stock splits (see SecEdgarOptions.historyYears).
    return sorted.slice(-(this.opts.historyYears ?? 5));
  }

  /**
   * Total debt for the anchor period, without double counting. `LongTermDebt` is the TOTAL
   * including its current portion (V FY2020 24.07B = 21.071 noncurrent + 2.999 current), so
   * adding `LongTermDebtCurrent` to it counted the current part twice. `DebtCurrent` already
   * includes current long-term debt (XOM: 9.3B incl. 6.2B), and commercial paper is debt (AAPL 8B).
   */
  private totalDebtAt(pointAt: (k: keyof typeof CONCEPTS) => number | null): number | null {
    const ltdCurrent = pointAt("longTermDebtCurrent");
    const cp = pointAt("commercialPaper");
    const stb = pointAt("shortTermBorrowings");
    const current =
      pointAt("debtCurrent") ??
      (ltdCurrent === null && cp === null && stb === null ? null : (ltdCurrent ?? 0) + (cp ?? 0) + (stb ?? 0));
    const ltdTotal = pointAt("longTermDebtTotal");
    const noncurrent = pointAt("longTermDebtNoncurrent") ?? (ltdTotal === null ? null : ltdTotal - (ltdCurrent ?? 0));
    return current === null && noncurrent === null ? null : (current ?? 0) + (noncurrent ?? 0);
  }

  /** CIKs to try for a symbol: the current one, then any predecessors. */
  private async ciksFor(symbol: string): Promise<string[]> {
    const upper = symbol.toUpperCase();
    const fallbacks = { ...DEFAULT_CIK_FALLBACKS, ...this.opts.cikFallbacks }[upper] ?? [];
    return [await this.cikFor(symbol), ...fallbacks.map((c) => String(c).padStart(10, "0"))];
  }

  async getFundamentals(symbol: string, asOf?: string): Promise<Fundamentals> {
    const f = await this.rawFundamentals(symbol, asOf);
    if (!PER_SHARE_CLASS_MISMATCH.has(symbol.toUpperCase())) return f;
    // EDGAR's per-share and share-count facts are for a DIFFERENT share class than the traded
    // ticker, so anything combining them with this ticker's price is wrong by the conversion ratio.
    // Growth rates and company-level totals (ROE, FCF, D/E) are ratio-free and stay.
    return { ...f, peRatio: null, marketCapUsd: null, netCashPerShare: null, fiveYearAvgPe: null, ebitToEv: null };
  }

  private async rawFundamentals(symbol: string, asOf?: string): Promise<Fundamentals> {
    const clock = asOf ?? new Date().toISOString();
    const ciks = await this.ciksFor(symbol);
    let cik = ciks[0]!;
    let gaap: Record<string, { units?: Record<string, Fact[]> }> | undefined;
    for (const candidate of ciks) {
      const res = await this.fetchImpl(`${this.baseUrl}/api/xbrl/companyfacts/CIK${candidate}.json`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        if (candidate === ciks[0]) throw new Error(`sec-edgar companyfacts ${symbol}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as CompanyFacts;
      const g = body.facts?.["us-gaap"];
      if (!g) continue;
      cik = candidate;
      gaap = g;
      // A predecessor is only consulted while the current filer has no annual history at the clock.
      if (this.annual(g, CONCEPTS.netIncome, clock, { duration: true }).length > 0) break;
    }
    if (!gaap) throw new Error(`sec-edgar ${symbol}: no us-gaap facts`);
    // Separate document, never blocks: sicFor swallows its own failures.
    const sicPromise = this.sicFor(cik);

    const flow = (k: keyof typeof CONCEPTS) => this.annual(gaap!, CONCEPTS[k], clock, { duration: true });
    const point = (k: keyof typeof CONCEPTS) => this.annual(gaap!, CONCEPTS[k], clock, { duration: false });

    const eps = splitAdjustEps(flow("eps"), [...flow("sharesDiluted"), ...point("sharesOutstanding")]) as Fact[];
    const revenue = flow("revenue");
    const netIncome = flow("netIncome");
    const inventory = point("inventory");
    const ocf = flow("operatingCashFlow");
    const dps = flow("dividendsPerShare");

    // ANCHOR every figure to one fiscal year: the newest annual period on the income statement.
    // A value from any other period is not "latest", it is stale, and is treated as unknown.
    const anchor = [eps, revenue, netIncome].map((f) => f[f.length - 1]?.end).filter((e): e is string => !!e).sort().pop();
    const anchorMs = anchor ? Date.parse(anchor) : null;
    const at = (series: Fact[]): number | null => {
      if (anchorMs === null) return null;
      const hit = series.find((f) => Math.abs(Date.parse(f.end) - anchorMs) <= SAME_PERIOD_DAYS * 86_400_000);
      return hit ? hit.val : null;
    };
    const pointAt = (k: keyof typeof CONCEPTS) => at(point(k));
    const flowAt = (k: keyof typeof CONCEPTS) => at(flow(k));
    /** Value for the fiscal year `yearsBack` before the anchor (±40 days for calendar drift). */
    const atYearsBack = (series: Fact[], yearsBack: number): number | null => {
      if (anchorMs === null) return null;
      const target = anchorMs - yearsBack * 365.25 * 86_400_000;
      const hit = series.find((f) => Math.abs(Date.parse(f.end) - target) <= 40 * 86_400_000);
      return hit ? hit.val : null;
    };

    // asOf = the newest period end we are allowed to see, NOT the request clock. The caller's
    // clock may be months after the last filing; claiming that as the data date would overstate
    // freshness and quietly break point-in-time reasoning downstream.
    const newestEnd = anchor;

    const epsLatest = at(eps);
    const epsHistory = eps
      .slice(1)
      .map((f, i) => pct(f.val, eps[i]!.val))
      .filter((x): x is number => x !== null);

    const totalDebt = this.totalDebtAt(pointAt);
    const sharesLatest = flowAt("sharesDiluted") ?? pointAt("sharesOutstanding");
    const equityLatest = pointAt("equity");
    const netCash =
      sharesLatest && sharesLatest > 0
        ? ((pointAt("cash") ?? 0) + (pointAt("shortTermInvestments") ?? 0) - (totalDebt ?? 0)) / sharesLatest
        : null;

    // Price-dependent fields require an injected market-data source; never guessed.
    let price: number | null = null;
    if (this.opts.marketData) {
      try {
        price = await this.opts.marketData.getLatestPrice(symbol, clock);
      } catch {
        price = null; // best-effort: a price outage must not fail the whole fundamentals fetch
      }
    }

    // Price history. Past P/E is rebuilt as RATIOS against today (price then/now from one split-
    // adjusted series, EPS then/now from the split-adjusted EPS series), so a split after the clock
    // (which a vendor's adjusted series already reflects) cancels out instead of distorting the level.
    let priceChange12mPct: number | null = null;
    let fiveYearAvgPe: number | null = null;
    const hp = this.opts.historyPrices;
    if (hp) {
      const px = async (at: string) => {
        try {
          const v = await hp.getLatestPrice(symbol, at);
          return v > 0 ? v : null;
        } catch {
          return null;
        }
      };
      const now = await px(clock);
      if (now !== null) {
        const ago = await px(new Date(Date.parse(clock) - YEAR_MS).toISOString());
        priceChange12mPct = ago === null ? null : (now / ago - 1) * 100;
        const peNow = price !== null && epsLatest !== null && epsLatest > 0 ? price / epsLatest : null;
        if (peNow !== null) {
          const pes: number[] = [];
          for (const f of eps) {
            if (f.val <= 0) continue;
            const then = await px(`${f.end.slice(0, 10)}T23:59:59Z`);
            if (then !== null) pes.push((peNow * (then / now)) / (f.val / epsLatest!));
          }
          fiveYearAvgPe = pes.length >= 3 ? pes.reduce((a, b) => a + b, 0) / pes.length : null;
        }
      }
    }
    // Filed strictly BEFORE the clock's date: a filing dated on the clock day may land after the
    // decision, and the data sets carry dates only.
    let insiderPurchases180d: number | null | undefined;
    const ip = this.opts.insiderPurchases;
    if (ip) {
      const day = clock.slice(0, 10);
      const start = new Date(Date.parse(clock) - 180 * 86_400_000).toISOString().slice(0, 10);
      insiderPurchases180d = [...new Set(ciks)].reduce(
        (n, c) => n + (ip[c] ?? []).filter(([d]) => d >= start && d < day).length,
        0,
      );
    }
    const epsChangePct = epsLatest !== null && eps.length >= 2 ? pct(eps[eps.length - 1]!.val, eps[eps.length - 2]!.val) : null;

    const ocfLatest = at(ocf);
    const fcf = ocfLatest !== null ? ocfLatest - (flowAt("capex") ?? 0) : null;
    // No declared dividend for the anchor year after paying before = suspended (BA 2020, INTC
    // 2024), i.e. 0 — not the last dividend ever paid. Never tagged at all = unknown.
    const dividend = at(dps) ?? (dps.length > 0 ? 0 : null);
    const sicCode = await sicPromise;

    // Piotroski inputs for the anchor year (t), the year before (t1) and t2's assets.
    const assetsS = point("assets");
    const revenueS = revenue;
    const grossS = flow("grossProfit");
    const costS = flow("costOfRevenue");
    const ltdS = point("longTermDebtNoncurrent");
    const yearInputs = (k: number): PiotroskiYear => {
      const rev = atYearsBack(revenueS, k);
      const gp = atYearsBack(grossS, k) ?? (rev !== null && atYearsBack(costS, k) !== null ? rev - atYearsBack(costS, k)! : null);
      return {
        netIncome: atYearsBack(netIncome, k),
        cfo: atYearsBack(ocf, k),
        assets: atYearsBack(assetsS, k),
        // Untagged long-term debt is read as none: most debt-free filers simply omit the concept.
        longTermDebt: atYearsBack(ltdS, k) ?? atYearsBack(point("longTermDebtTotal"), k) ?? 0,
        currentAssets: atYearsBack(point("assetsCurrent"), k),
        currentLiabilities: atYearsBack(point("liabilitiesCurrent"), k),
        sharesDiluted: atYearsBack(flow("sharesDiluted"), k),
        revenue: rev,
        grossProfit: gp,
      };
    };
    const piotroski = anchor ? piotroskiFScore(yearInputs(0), yearInputs(1), { assets: atYearsBack(assetsS, 2) }) : null;
    // EBIT/EV. Banks and insurers rarely tag OperatingIncomeLoss, so they come out null, which is
    // right: debt is a financial's raw material, not a claim on the operating business.
    const marketCap = price !== null && sharesLatest !== null ? price * sharesLatest : null;
    // Untagged interest in the fallback reads as none, which understates EBIT only for levered filers.
    const pretax = flowAt("pretaxIncome");
    const ebit = flowAt("operatingIncome") ?? (pretax === null ? null : pretax + (flowAt("interestExpense") ?? 0));
    const ev =
      marketCap === null ? null : marketCap + (totalDebt ?? 0) - (pointAt("cash") ?? 0) - (pointAt("shortTermInvestments") ?? 0);
    const ebitToEv = ebit !== null && ev !== null && ev > 0 ? ebit / ev : null;
    const yoy = (series: Fact[]) => {
      const cur = at(series);
      const prevFact = cur === null ? undefined : series[series.length - 2];
      return cur !== null && prevFact ? pct(cur, prevFact.val) : null;
    };

    return {
      symbol: symbol.toUpperCase(),
      asOf: newestEnd ?? clock.slice(0, 10),
      peRatio: price !== null && epsLatest !== null && epsLatest > 0 ? price / epsLatest : null,
      epsGrowthPct: epsLatest === null ? null : epsCagr(eps),
      epsGrowthHistoryPct: epsHistory,
      dividendYieldPct: price !== null && dividend !== null && price > 0 ? (dividend / price) * 100 : null,
      payoutRatio: dividend !== null && epsLatest !== null && epsLatest > 0 ? dividend / epsLatest : null,
      debtToEquity: ratio(totalDebt, equityLatest),
      netCashPerShare: netCash,
      roePct: (() => {
        const r = ratio(at(netIncome), equityLatest);
        return r === null ? null : r * 100;
      })(),
      currentRatio: ratio(pointAt("assetsCurrent"), pointAt("liabilitiesCurrent")),
      freeCashFlow: fcf,
      revenueGrowthPct: yoy(revenue),
      inventoryGrowthPct: yoy(inventory),
      marketCapUsd: marketCap,
      salesUsd: at(revenue),
      // Not derivable from XBRL financial statements — 13F/Form 4 are separate datasets, and a
      // cross-sectional median needs a universe pass. Null is honest; a guess would corrupt the
      // Lynch gates that read these.
      institutionalOwnershipPct: null,
      institutionalOwnershipMedianPct: null,
      insiderNetBuying: null,
      fiveYearAvgPe,
      earningsCyclicality: null,
      distressed: null,
      hiddenAssetValueToMarketCap: null,
      sicCode,
      piotroski,
      ebitToEv,
      priceChange12mPct,
      epsChangePct,
      ...(insiderPurchases180d !== undefined ? { insiderPurchases180d } : {}),
    };
  }
}
