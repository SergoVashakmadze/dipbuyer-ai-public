import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Injectable } from "@nestjs/common";
import { sectorForSic, type Fundamentals } from "@dipbuyer/shared";
import { runBacktest, type BacktestParams, type BacktestResult } from "@dipbuyer/backtest";
import {
  AlpacaMarketData,
  FinancialDatasetsFundamentals,
  InMemoryFundamentals,
  InMemoryMarketData,
  PolygonMarketData,
  SecEdgarFundamentals,
  loadTbillRates,
  type FundamentalsAdapter,
  type MarketDataAdapter,
  type PriceBar,
  Sp500Membership,
  WindowCachedMarketData,
} from "@dipbuyer/data";
import { loadStrategyConfig } from "@dipbuyer/strategy";

export interface BacktestRequest {
  universe?: string[];
  from?: string;
  to?: string;
  rebalance?: "annual" | "quarterly" | "monthly" | "weekly" | "daily";
  initialCapital?: number;
  /**
   * Screen the POINT-IN-TIME S&P 500 membership instead of `universe`, including names that were
   * later delisted, acquired or went bankrupt. This is the survivorship-bias fix: without it a
   * result is optimistic by construction and must not be presented as strategy evidence.
   *
   * Costs real time — the investable set is ~500 names per clock rather than a hand-picked few
   * dozen, and price calls dominate the run.
   */
  pointInTimeUniverse?: boolean;
  /**
   * Return a slim projection of every DecisionRecord for offline ATTRIBUTION — which categories,
   * sectors and conviction bands actually made or lost money. Off by default: a 10-year run emits
   * ~54k records and the full DecisionRecord carries the whole criteria checklist, which would
   * bloat an API response by orders of magnitude. Only the backtest CLI sets it.
   */
  includeDecisionSummaries?: boolean;
}

/**
 * The minimum needed to attribute performance: what was decided, about what, when, and how
 * strongly. Forward returns are joined in offline from prices — deliberately NOT computed here,
 * because a backtest must never look forward from its own clock.
 */
export interface DecisionSummary {
  ts: string;
  symbol: string;
  category: string | null;
  verdict: string;
  convictionScore: number;
  sector: string | null;
}

export interface BacktestResponse {
  params: BacktestResult["params"];
  metrics: BacktestResult["metrics"];
  equityCurve: BacktestResult["equityCurve"];
  decisions: number;
  /** Where the inputs came from, so a curve built on fixtures is never mistaken for real. */
  dataSource: {
    fundamentals: string;
    /** "alpaca" | "polygon" | "in-memory-demo" — the adapter ACTUALLY used, not a label. */
    marketData: string;
    /**
     * Alpaca feed ("iex" | "sip") when marketData is "alpaca", else null. Recorded because the feed
     * changes the data floor (IEX: 2021, SIP: 2016) and the volume behind the ADV gate, and past
     * runs could not be told apart after the fact.
     */
    marketDataFeed: string | null;
    synthetic: boolean;
  };
  /**
   * Publication-lag assumption applied to fundamentals (days). Null when synthetic OR when the
   * source carries real filing dates — check `exactFilingDates` to tell those apart.
   */
  reportingLagDays: number | null;
  /**
   * How the universe was chosen. `sp500-point-in-time` includes delisted/acquired names and is
   * survivorship-controlled; `static-handpicked` is a list of survivors and is OPTIMISTIC — such a
   * result is indicative only and must never be presented to an investor or regulator as evidence.
   * Recorded rather than inferred, so a number can never be quoted without its bias status.
   */
  universeSource: string;
  /**
   * Share of the universe (0..1) that resolved to a sector, and so is actually subject to the 30%
   * concentration cap. Reported rather than assumed: the cap was INERT for every run before this
   * (`sectorOf` was never passed), and a partially-classified universe caps only part of the book
   * while looking fully controlled. `null` = no sector source at all (non-EDGAR fundamentals).
   */
  sectorCoverage: number | null;
  /** Slim per-decision projection for attribution. Present only when requested. */
  decisionSummaries?: DecisionSummary[];
  /**
   * True when the point-in-time cut used ACTUAL filing dates (SEC EDGAR) rather than an assumed
   * publication lag. Results from an exact run are not directly comparable to lag-estimated ones.
   */
  exactFilingDates: boolean;
  /** Symbol-clocks skipped on data-source failures; non-zero invalidates the metrics. */
  dataSourceFailures: number;
}

/**
 * Assumed gap between a fiscal period ending and its report being filed. The API filters on
 * `report_period` (period end), so without this a backtest would see figures before they were
 * public — look-ahead bias that flatters results. 90d is conventional for annual US filings.
 */
const BACKTEST_REPORTING_LAG_DAYS = 90;

// Fixed-day steps, matching the approximate style of the original monthly:30. quarterly:91 and
// annual:365 are the natural extensions. MUST stay in lockstep with PERIODS_PER_YEAR in
// packages/backtest/src/run.ts (12/4/1 for monthly/quarterly/annual) or metrics mis-annualise.
// Attribution (2026-07-20) showed the conviction signal only emerges over 1-5yr holds, so the
// LONGER cadences are the point — monthly churns at the horizon where the edge is weakest.
const STEP_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, annual: 365 } as const;

/** Build an evenly spaced point-in-time rebalance schedule between two ISO dates. */
function makeSchedule(from: string, to: string, rebalance: keyof typeof STEP_DAYS): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const stepMs = STEP_DAYS[rebalance] * 86_400_000;
  const out: string[] = [];
  for (let t = start; t <= end; t += stepMs) out.push(new Date(t).toISOString());
  return out;
}

/**
 * Demo dataset so the backtest endpoint returns a real equity curve without API keys:
 * cheap fast growers (bought) vs names containing "RICH" (expensive, never bought),
 * with a steadily rising price series. Swap for AlpacaMarketData + FinancialDatasetsFundamentals
 * once keys are wired (HANDOVER.md).
 */
function demoData(universe: string[], schedule: string[]) {
  const fmap = new Map<string, Fundamentals[]>();
  const bmap = new Map<string, PriceBar[]>();
  const firstDay = schedule[0]?.slice(0, 10) ?? "2025-01-01";
  for (const symbol of universe) {
    const expensive = symbol.toUpperCase().includes("RICH");
    fmap.set(symbol, [
      {
        symbol,
        asOf: `${firstDay}T00:00:00Z`,
        peRatio: expensive ? 60 : 12,
        epsGrowthPct: 25,
        epsGrowthHistoryPct: [22, 24, 25],
        dividendYieldPct: 0,
        payoutRatio: 0,
        debtToEquity: 0.2,
        netCashPerShare: 1,
        roePct: 18,
        currentRatio: 1.5,
        freeCashFlow: 1,
        revenueGrowthPct: 28,
        inventoryGrowthPct: 5,
        marketCapUsd: 2e9,
        salesUsd: 1.5e9,
        institutionalOwnershipPct: 30,
        institutionalOwnershipMedianPct: 50,
        insiderNetBuying: true,
        fiveYearAvgPe: expensive ? 60 : 12,
        earningsCyclicality: "low",
        distressed: false,
        hiddenAssetValueToMarketCap: null,
      } as Fundamentals,
    ]);
    bmap.set(
      symbol,
      schedule.map((ts, i) => {
        const close = 10 * Math.pow(1.03, i); // +3% per step
        return { symbol, ts, open: close, high: close, low: close, close, volume: 1_000_000 };
      }),
    );
  }
  return {
    fundamentals: new InMemoryFundamentals(fmap, "backtest-synthetic"),
    marketData: new InMemoryMarketData(bmap),
  };
}

export type BacktestPriceSource = "alpaca" | "polygon";

/**
 * `BACKTEST_PRICE_SOURCE` = alpaca (default — existing runs unchanged) | polygon.
 * An unrecognised value THROWS rather than falling back: a typo silently running on the other
 * source would produce a "comparison" of a source against itself.
 */
export function backtestPriceSource(env: NodeJS.ProcessEnv = process.env): BacktestPriceSource {
  const raw = (env.BACKTEST_PRICE_SOURCE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "alpaca") return "alpaca";
  if (raw === "polygon" || raw === "massive") return "polygon";
  throw new Error(`BACKTEST_PRICE_SOURCE="${env.BACKTEST_PRICE_SOURCE}" is not one of: alpaca, polygon`);
}

/**
 * `BACKTEST_CASH_POLICY` = benchmark (DEFAULT since 2026-09-16) | tbill | none. See
 * BacktestParams.cashPolicy. Default chosen from the R1-R5 experiments in HANDOVER.md: parking idle
 * cash in the benchmark added ~1.2 pts/yr on the survivorship-controlled universe. `none` reproduces
 * pre-2026-09-16 runs. Unknown values throw, so a typo cannot silently run the default.
 */
export function backtestCashPolicy(env: NodeJS.ProcessEnv = process.env): "none" | "tbill" | "benchmark" {
  const raw = (env.BACKTEST_CASH_POLICY ?? "").trim().toLowerCase();
  if (raw === "" || raw === "benchmark") return "benchmark";
  if (raw === "tbill" || raw === "none") return raw;
  throw new Error(`BACKTEST_CASH_POLICY="${env.BACKTEST_CASH_POLICY}" is not one of: benchmark, tbill, none`);
}

/** `BACKTEST_SIZING` = "equal" (default) | "market-cap" | "sector-neutral". See BacktestParams.sizing. */
export function backtestSizing(env: NodeJS.ProcessEnv = process.env): BacktestParams["sizing"] {
  const raw = (env.BACKTEST_SIZING ?? "").trim().toLowerCase();
  if (raw === "" || raw === "equal") return undefined;
  if (raw === "market-cap" || raw === "sector-neutral") return raw;
  throw new Error(`BACKTEST_SIZING="${env.BACKTEST_SIZING}" is not one of: equal, market-cap, sector-neutral`);
}

/** `BACKTEST_SELL_POLICY` = "any-avoid" (default) | "hard-rules". See BacktestParams.sellPolicy. */
export function backtestSellPolicy(env: NodeJS.ProcessEnv = process.env): BacktestParams["sellPolicy"] {
  const raw = (env.BACKTEST_SELL_POLICY ?? "").trim().toLowerCase();
  if (raw === "" || raw === "any-avoid") return undefined;
  if (raw === "hard-rules") return "hard-rules";
  throw new Error(`BACKTEST_SELL_POLICY="${env.BACKTEST_SELL_POLICY}" is not one of: any-avoid, hard-rules`);
}

/**
 * `BACKTEST_PROFIT_TAKE` = "<gainPct>,<category+category>,<cooldownPeriods>", e.g. "50,stalwart+slow_grower,6".
 * Unset = never take profits. See BacktestParams.profitTake.
 */
export function backtestProfitTake(env: NodeJS.ProcessEnv = process.env): BacktestParams["profitTake"] {
  const raw = (env.BACKTEST_PROFIT_TAKE ?? "").trim();
  if (!raw) return undefined;
  const [pct, cats, cooldown] = raw.split(",").map((x) => x.trim());
  const gainPct = Number(pct);
  const cooldownPeriods = Number(cooldown ?? 0);
  const categories = (cats ?? "").split("+").map((c) => c.trim()).filter(Boolean);
  if (!(gainPct > 0) || categories.length === 0 || !Number.isInteger(cooldownPeriods) || cooldownPeriods < 0) {
    throw new Error(`BACKTEST_PROFIT_TAKE="${env.BACKTEST_PROFIT_TAKE}" must be "<gainPct>,<cat+cat>,<cooldownPeriods>", e.g. "50,stalwart+slow_grower,6"`);
  }
  return { gainPct, categories, cooldownPeriods };
}

/**
 * `BACKTEST_DIP_ENTRY` = "<minDrawdownPct>" or "<minDrawdownPct>,stable" (e.g. "15,stable"); unset =
 * buy on the verdict alone. See BacktestParams.dipEntry.
 */
export function backtestDipEntry(env: NodeJS.ProcessEnv = process.env): BacktestParams["dipEntry"] {
  const raw = (env.BACKTEST_DIP_ENTRY ?? "").trim();
  if (!raw) return undefined;
  const [pct, flag] = raw.split(",").map((x) => x.trim().toLowerCase());
  const minDrawdownPct = Number(pct);
  if (!Number.isFinite(minDrawdownPct) || minDrawdownPct <= 0 || minDrawdownPct >= 100 || (flag && flag !== "stable")) {
    throw new Error(`BACKTEST_DIP_ENTRY="${env.BACKTEST_DIP_ENTRY}" must be "<pct>" or "<pct>,stable", e.g. "15,stable"`);
  }
  return { minDrawdownPct, requireStabilization: flag === "stable" };
}

/**
 * Delisted-ticker CIK overrides (packages/data/vendor/cik-overrides.json), ON by default since
 * 2026-09-16: without them 144 delisted S&P members could never be screened and results were
 * flattered by ~1.6 pts/yr (HANDOVER.md R3). `BACKTEST_CIK_OVERRIDES=0` reproduces older runs.
 */
export function backtestCikOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (["0", "false", "no", "off"].includes((env.BACKTEST_CIK_OVERRIDES ?? "").trim().toLowerCase())) return undefined;
  const file = fileURLToPath(new URL("../../../../packages/data/vendor/cik-overrides.json", import.meta.url));
  const data = JSON.parse(readFileSync(file, "utf8")) as { overrides: Record<string, { cik: string }> };
  return Object.fromEntries(Object.entries(data.overrides).map(([t, v]) => [t, v.cik]));
}

/**
 * Real adapters when configured, else the synthetic demo set.
 *
 * Prices come from Alpaca by default, or from Polygon/Massive with BACKTEST_PRICE_SOURCE=polygon
 * (a research-grade history feed, for like-for-like reruns). Real market data is a hard
 * prerequisite: fixture prices against real fundamentals (or the reverse) is a meaningless hybrid,
 * and we fall back wholesale rather than silently mixing. The one exception is an EXPLICIT
 * polygon selection without POLYGON_API_KEY, which throws — the caller asked for a specific source.
 *
 * Fundamentals preference is deliberate and OPPOSITE to the live-analysis chain:
 *
 *  - **SEC EDGAR first for backtests.** It publishes the real `filed` date, so the point-in-time
 *    cut is EXACT. The paid path only exposes fiscal period end, forcing a 90-day publication-lag
 *    estimate — an approximation that is either too generous (look-ahead) or too conservative
 *    (hiding data the market had). For a backtest, correctness of the clock beats field coverage.
 *  - financialdatasets.ai second: richer fields, but the lag estimate is the best it can do.
 *
 * Live analysis prefers the paid source instead (decision.providers.ts), where "latest available"
 * is the right semantics and the extra insider/institutional fields carry real weight.
 */
export function buildBacktestData(
  universe: string[],
  schedule: string[],
): {
  fundamentals: FundamentalsAdapter;
  marketData: MarketDataAdapter;
  lagDays: number | null;
  exactFilingDates: boolean;
  /** Price adapter actually in use ("in-memory-demo" when synthetic). */
  marketDataSource: string;
  /** Alpaca feed when marketDataSource is "alpaca", else null. */
  marketDataFeed: string | null;
} {
  const priceSource = backtestPriceSource();
  const synthetic = () => ({
    ...demoData(universe, schedule),
    lagDays: null,
    exactFilingDates: false,
    marketDataSource: "in-memory-demo",
    marketDataFeed: null,
  });

  // TWO price feeds, deliberately. They answer different questions and must not be swapped.
  //
  //  - `alpaca` (adjustment=all): TRADING and MARKING. Raw bars show a split as a crash — AAPL
  //    2020 $499->$129, NVDA 2024 $1209->$122 — so a held position took a fake ~90% loss. SPY has
  //    not split since 2005, so the benchmark was untouched while the portfolio was destroyed.
  //    `all` also folds dividends in, making this a TOTAL-return series rather than price-only.
  //  - `alpacaRaw`: VALUATION ONLY. SEC EPS is AS-FILED, in then-current share terms. An adjusted
  //    price over as-filed EPS understates PE by the split factor (AAPL FY2019 -> ~4.2 vs ~17),
  //    which would make every pre-split company look absurdly cheap and be bought.
  //
  // Both sources expose the same four adjustment modes, so the pair is built identically either way.
  let adjusted: MarketDataAdapter;
  let rawPrices: MarketDataAdapter;
  let splitPrices: MarketDataAdapter;
  let marketDataFeed: string | null = null;
  if (priceSource === "polygon") {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
      throw new Error("BACKTEST_PRICE_SOURCE=polygon requires POLYGON_API_KEY (Alpaca keys are not needed).");
    }
    const baseUrl = process.env.POLYGON_BASE_URL || undefined;
    adjusted = new PolygonMarketData({ apiKey, baseUrl, adjustment: "all" });
    rawPrices = new PolygonMarketData({ apiKey, baseUrl, adjustment: "raw" });
    splitPrices = new PolygonMarketData({ apiKey, baseUrl, adjustment: "split" });
  } else {
    const alpacaId = process.env.ALPACA_KEY_ID;
    const alpacaSecret = process.env.ALPACA_SECRET_KEY;
    if (!alpacaId || !alpacaSecret) return synthetic();
    // `||`, not `??`: an empty `ALPACA_DATA_FEED=` line must mean the documented default, not an
    // empty feed string sent to Alpaca (and recorded in the result as if it were a feed).
    const feed = ((process.env.ALPACA_DATA_FEED || "iex") as "iex" | "sip");
    marketDataFeed = feed;
    adjusted = new AlpacaMarketData({ keyId: alpacaId, secretKey: alpacaSecret, feed, adjustment: "all" });
    rawPrices = new AlpacaMarketData({ keyId: alpacaId, secretKey: alpacaSecret, feed, adjustment: "raw" });
    splitPrices = new AlpacaMarketData({ keyId: alpacaId, secretKey: alpacaSecret, feed, adjustment: "split" });
  }
  const marketDataSource: string = priceSource;

  // Prefetch each symbol's bars ONCE for the window rather than per symbol-per-clock. With a
  // point-in-time universe (~500 names) a 3-year monthly run is ~37,000 price calls otherwise;
  // this makes it ~500. Lead the window by the ADV lookback (30 bars, ~3x calendar slack for
  // weekends/holidays) so the liquidity gate still has its trailing history on the first clock.
  const first = schedule[0] ?? new Date().toISOString();
  const last = schedule.at(-1) ?? first;
  const prefetchFrom = new Date(Date.parse(first) - 30 * 3 * 86_400_000).toISOString();
  const marketData = new WindowCachedMarketData(adjusted, prefetchFrom, last);
  const rawForValuation = new WindowCachedMarketData(rawPrices, prefetchFrom, last);
  // Price history for the price-history criteria (P/E vs own history reaches ~5 fiscal years back,
  // 12-month change one year). Only wired when the strategy config enables one of them: it is a
  // second long bar fetch per symbol that canonical runs do not need.
  const gc = loadStrategyConfig().config.global_criteria ?? {};
  const wantsHistory = ["pe_vs_own_history", "earnings_up_price_down", "momentum_12m"].some(
    (k) => (gc[k] as { enabled?: boolean } | undefined)?.enabled,
  );
  const historyPrices = wantsHistory
    ? new WindowCachedMarketData(splitPrices, new Date(Date.parse(first) - 6.5 * 365.25 * 86_400_000).toISOString(), last)
    : undefined;

  // Insider purchase index (build-insider-index.mjs), loaded only when a config enables the criterion.
  // A missing file is an error, not a silent null column: the run would look like "no signal".
  const insiderPurchases = (gc.insider_open_market_buy as { enabled?: boolean } | undefined)?.enabled
    ? (JSON.parse(
        readFileSync(process.env.BACKTEST_INSIDER_INDEX || `${process.env.HOME}/dipbuyer-data/insider-purchases.json`, "utf8"),
      ) as Record<string, Array<[string, number]>>)
    : undefined;

  const edgarUa = process.env.SEC_EDGAR_USER_AGENT;
  if (edgarUa) {
    // The adapter caches companyfacts (~3.5 MB, full history in one payload), so a sweep over
    // many rebalance dates costs ONE request per symbol.
    return {
      fundamentals: new SecEdgarFundamentals({ userAgent: edgarUa, marketData: rawForValuation, historyPrices, insiderPurchases, cikOverrides: backtestCikOverrides() }),
      marketData,
      lagDays: null, // not needed — real filing dates
      exactFilingDates: true,
      marketDataSource,
      marketDataFeed,
    };
  }

  const fdKey = process.env.FINANCIALDATASETS_API_KEY;
  if (fdKey) {
    return {
      fundamentals: new FinancialDatasetsFundamentals({
        apiKey: fdKey,
        reportingLagDays: BACKTEST_REPORTING_LAG_DAYS,
      }),
      marketData,
      lagDays: BACKTEST_REPORTING_LAG_DAYS,
      exactFilingDates: false,
      marketDataSource,
      marketDataFeed,
    };
  }
  return synthetic();
}

/**
 * Symbol -> coarse sector, prefetched from EDGAR SIC codes (M2).
 *
 * `RunDeps.sectorOf` is SYNCHRONOUS, so the map must be complete before the first buy — deriving
 * it lazily during screening would leave the earliest-processed names unclassified and the 30%
 * concentration cap silently partial, which is how it came to be inert in the first place.
 *
 * Only EDGAR can supply SIC. Under any other source this returns undefined and the caller leaves
 * `sectorOf` unset, which is the honest state: the cap does not fire because nothing is
 * classified, rather than appearing to fire on a guess.
 *
 * Best-effort per symbol: a lookup failure maps to null (uncapped) instead of failing the run.
 *
 * ⚠️ PACED, DELIBERATELY SEQUENTIAL. The first version ran 8 workers concurrently, which bursts
 * ~80 req/s against SEC's ~10 req/s limit and rate-limited the WHOLE run into HTTP 429s:
 * symbol-clocks lost to data-source failures went 0.0% -> 0.2% and elapsed went 2442s -> 9464s.
 * Those 429s silently delete names from rebalances (bug #5's shape), so a "faster" prefetch
 * corrupted the results it was meant to enable. One request per SEC_MIN_INTERVAL_MS is ~9 req/s,
 * provably under the limit; 724 names costs ~80s ONCE, and the 6h HTTP cache makes re-runs free.
 * Do not parallelise this without a shared rate limiter across every SEC caller in the process.
 */
const SEC_MIN_INTERVAL_MS = 110;

async function buildSectorMap(
  fundamentals: FundamentalsAdapter,
  universe: string[],
): Promise<Map<string, string | null> | undefined> {
  if (!(fundamentals instanceof SecEdgarFundamentals)) return undefined;
  const map = new Map<string, string | null>();
  let nextAllowedAt = 0;
  for (const symbol of universe) {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + SEC_MIN_INTERVAL_MS;
    try {
      map.set(symbol, sectorForSic(await fundamentals.getSicCode(symbol)));
    } catch {
      map.set(symbol, null);
    }
  }
  return map;
}

@Injectable()
export class BacktestService {
  async run(req: BacktestRequest): Promise<BacktestResponse> {
    const universe = req.universe?.length ? req.universe.map((s) => s.toUpperCase()) : ["AAPL", "MSFT"];
    const from = req.from ?? "2025-01-01T00:00:00Z";
    const to = req.to ?? "2025-12-31T00:00:00Z";
    const rebalance = req.rebalance ?? "monthly";
    const schedule = makeSchedule(from, to, rebalance);

    // Point-in-time membership, when requested. `universeAt` drives what is screened per clock;
    // `effectiveUniverse` is the union actually reachable over the window, which is what the data
    // adapters must be able to serve (and what gets recorded in params for reproducibility).
    let universeAt: ((clock: string) => readonly string[]) | undefined;
    let effectiveUniverse = universe;
    let universeSource = "static-handpicked";
    if (req.pointInTimeUniverse) {
      const membership = Sp500Membership.fromFile();
      const through = membership.snapshotThrough();
      // Past the snapshot the file simply keeps returning today's members, which looks like a
      // valid answer for a future date. Refuse rather than silently reintroduce survivorship bias.
      if (to.slice(0, 10) > through) {
        throw new Error(
          `pointInTimeUniverse: requested window ends ${to.slice(0, 10)} but the vendored ` +
            `membership snapshot only runs through ${through}. Beyond it the universe silently ` +
            `becomes "companies that exist today" — the exact bias this fixes. Refresh ` +
            `packages/data/vendor/sp500-membership.csv (see vendor/README.md) or shorten the window.`,
        );
      }
      universeAt = (clock: string) => membership.at(clock);
      effectiveUniverse = [...new Set(schedule.flatMap((c) => membership.at(c)))].sort();
      universeSource = "sp500-point-in-time";
    }

    const { fundamentals, marketData, lagDays, exactFilingDates, marketDataSource, marketDataFeed } =
      buildBacktestData(effectiveUniverse, schedule);

    const params: BacktestParams = {
      universe: effectiveUniverse,
      from,
      to,
      rebalance,
      initialCapital: req.initialCapital ?? 10_000,
      frictions: { commissionBps: 5, slippageBps: 10, spreadBps: 5 },
      // SPY, not ^GSPC: Alpaca rejects index tickers ("invalid symbol"), and the failure used to
      // be silent — every benchmark price failed, so the comparison fell back to a 0% benchmark
      // and a run trailing the S&P by 71 points reported +10.30 relative.
      benchmark: "SPY",
      seed: 1,
    };
    const sectors = await buildSectorMap(fundamentals, effectiveUniverse);
    const sectorOf = sectors ? (symbol: string) => sectors.get(symbol.toUpperCase()) ?? null : undefined;

    const cashPolicy = backtestCashPolicy();
    params.cashPolicy = cashPolicy;
    params.dipEntry = backtestDipEntry();
    params.sellPolicy = backtestSellPolicy();
    params.profitTake = backtestProfitTake();
    params.sizing = backtestSizing();
    const cashRatePct = cashPolicy === "tbill" ? loadTbillRates() : undefined;
    const result = await runBacktest(params, { fundamentals, marketData, schedule, universeAt, sectorOf, cashRatePct });
    return {
      params: result.params,
      metrics: result.metrics,
      equityCurve: result.equityCurve,
      decisions: result.decisionRecords.length,
      dataSourceFailures: result.dataSourceFailures,
      universeSource,
      sectorCoverage: sectors
        ? [...sectors.values()].filter((s) => s !== null).length / Math.max(sectors.size, 1)
        : null,
      decisionSummaries: req.includeDecisionSummaries
        ? result.decisionRecords.map((d) => ({
            ts: d.ts,
            symbol: d.symbol,
            category: d.lynchCategory,
            verdict: d.verdict,
            convictionScore: d.convictionScore,
            sector: sectorOf?.(d.symbol) ?? null,
            // [name, result, value] per criterion, for offline "which criteria rank" analysis.
            criteria: d.criteria.map((c) => [c.name, c.result, c.value]),
          }))
        : undefined,
      dataSource: {
        fundamentals: fundamentals.sourceId,
        marketData: marketDataSource,
        marketDataFeed,
        synthetic: fundamentals.sourceId === "backtest-synthetic",
      },
      reportingLagDays: lagDays,
      exactFilingDates,
    };
  }
}
