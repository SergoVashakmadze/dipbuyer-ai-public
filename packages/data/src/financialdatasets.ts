import type { Fundamentals } from "@dipbuyer/shared";
import type { FundamentalsAdapter } from "./index.js";
import { withRetry, type RetryOptions } from "./http.js";

/**
 * financialdatasets.ai fundamentals adapter. Alpaca provides NO fundamentals, so this is the
 * primary source for the Lynch engine (P/E, growth, D/E, ROE, FCF, etc.).
 *
 * Base metrics: GET /financial-metrics?ticker=&period=annual&limit=5  (auth: X-API-KEY)
 *
 * Enrichment (when `enrich`, default true) — fields /financial-metrics does NOT supply, fetched in
 * parallel and merged; any enrichment failure leaves its field null without breaking the core fetch:
 *   - inventoryGrowthPct + netCashPerShare  ← GET /financials/balance-sheets (2 annual periods)
 *   - insiderNetBuying                       ← GET /insider-trades (trailing window)
 *
 * Still unmapped (not obtainable cleanly from this API per ticker, left null):
 *   - institutionalOwnershipPct/Median: 13F gives raw shares only; the median is a cross-sectional
 *     universe statistic — compute it in a screening pass, not here (the score gate needs both).
 *   - earningsCyclicality / distressed / hiddenAssetValueToMarketCap: qualitative / sector-derived.
 *
 * `fetch` is injectable for offline testing and is wrapped with `withRetry` (429/5xx + Retry-After)
 * by default; pass `cache`-wrapped fetch via fetchImpl for cross-call caching.
 */
export interface FinancialDatasetsOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Fetch balance-sheet + insider enrichment after base metrics (default true). */
  enrich?: boolean;
  /** Retry behaviour for the wrapped fetch (429/5xx). */
  retry?: RetryOptions;
  /**
   * Days to assume between a fiscal period ENDING and the report being PUBLISHED.
   *
   * The API filters on `report_period`, i.e. the fiscal period end — not the filing date.
   * FY2025 ends 31-Dec-2025 but is not public until ~Feb-2026, so a backtest standing at
   * 15-Jan-2026 that asked for `report_period_lte=2026-01-15` would receive figures nobody
   * could have had: look-ahead bias, and it flatters results.
   *
   * Setting this shifts the point-in-time cutoff back by N days so only reports plausibly
   * published by the clock are visible. Default 0 (live analysis, where "latest available"
   * is correct). BACKTESTS MUST SET THIS — 90 days is the conventional conservative choice
   * for annual US filings.
   */
  reportingLagDays?: number;
}

type Raw = Record<string, number | string | boolean | null | undefined>;

/** Trailing window (days) for the insider net-buying signal. */
const INSIDER_WINDOW_DAYS = 365;

export class FinancialDatasetsFundamentals implements FundamentalsAdapter {
  readonly sourceId = "financialdatasets.ai";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly enrich: boolean;

  constructor(private readonly opts: FinancialDatasetsOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.financialdatasets.ai";
    this.fetchImpl = withRetry(opts.fetchImpl ?? fetch, opts.retry);
    this.enrich = opts.enrich ?? true;
  }

  async getFundamentals(symbol: string, asOf?: string): Promise<Fundamentals> {
    const base = await this.fetchMetrics(symbol, asOf);
    if (!this.enrich) return base;

    // Enrichments are best-effort: a failure leaves the field null, never breaks core fundamentals.
    const [balances, insider] = await Promise.allSettled([
      this.fetchBalanceSheets(symbol, asOf),
      this.fetchInsiderTrades(symbol, asOf),
    ]);
    if (balances.status === "fulfilled") {
      base.inventoryGrowthPct = inventoryGrowthPctFromBalances(balances.value);
      const newest = balances.value[0];
      if (newest) base.netCashPerShare = netCashPerShareFromBalance(newest);
    }
    if (insider.status === "fulfilled") {
      base.insiderNetBuying = insiderNetBuyingFromTrades(insider.value);
    }
    return base;
  }

  /** Shared GET: X-API-KEY auth, throws on !ok, returns parsed JSON. */
  private async fetchJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), { headers: { "X-API-KEY": this.opts.apiKey } });
    if (!res.ok) throw new Error(`financialdatasets ${path}: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Point-in-time cutoff for `report_period_lte`: the clock shifted back by the assumed
   * publication lag, so a backtest never sees a report before it could have been filed.
   */
  private cutoff(asOf: string): string {
    const lagDays = this.opts.reportingLagDays ?? 0;
    if (lagDays <= 0) return asOf.slice(0, 10);
    return new Date(Date.parse(asOf) - lagDays * 86_400_000).toISOString().slice(0, 10);
  }

  private async fetchMetrics(symbol: string, asOf?: string): Promise<Fundamentals> {
    const params: Record<string, string> = { ticker: symbol, period: "annual", limit: "5" };
    if (asOf) params["report_period_lte"] = this.cutoff(asOf); // point-in-time: no look-ahead
    const body = (await this.fetchJson("/financial-metrics", params)) as { financial_metrics?: Raw[] };
    const rows = (body.financial_metrics ?? [])
      .slice()
      .sort((a, b) => (String(a["report_period"]) < String(b["report_period"]) ? 1 : -1)); // newest first
    const newest = rows[0];
    if (!newest) throw new Error(`financialdatasets ${symbol}: no metrics`);
    const history = rows
      .slice()
      .reverse()
      .map((r) => pct(r["earnings_per_share_growth"]))
      .filter((x): x is number => x !== null); // oldest→newest, whole %
    return mapMetrics(symbol, newest, asOf, history);
  }

  private async fetchBalanceSheets(symbol: string, asOf?: string): Promise<Raw[]> {
    const params: Record<string, string> = { ticker: symbol, period: "annual", limit: "2" };
    if (asOf) params["report_period_lte"] = this.cutoff(asOf); // same publication-lag guard as metrics
    const body = await this.fetchJson("/financials/balance-sheets", params);
    return rowsOf(body, "balance_sheets").slice().sort((a, b) =>
      String(a["report_period"]) < String(b["report_period"]) ? 1 : -1,
    ); // newest first
  }

  private async fetchInsiderTrades(symbol: string, asOf?: string): Promise<Raw[]> {
    const params: Record<string, string> = { ticker: symbol, limit: "100" };
    if (asOf) {
      const lte = asOf.slice(0, 10);
      params["filing_date_lte"] = lte;
      params["filing_date_gte"] = dateDaysBefore(lte, INSIDER_WINDOW_DAYS);
    }
    const body = await this.fetchJson("/insider-trades", params);
    return rowsOf(body, "insider_trades");
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Percent helper: financialdatasets returns growth as a fraction (0.2) → whole-number % (20). */
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n * 100;
};

/** Accept either the REST wrapper ({ key: [...] }) or a bare array (MCP-style) response shape. */
function rowsOf(body: unknown, key: string): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  const wrapped = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as Raw[]) : [];
}

/** YYYY-MM-DD that is `days` before the given date. */
function dateDaysBefore(isoDate: string, days: number): string {
  return new Date(Date.parse(isoDate) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Dividend yield, which /financial-metrics omits, is an identity from fields it DOES return:
 *   yield = DPS/price = (payout_ratio·EPS)/price = payout_ratio / (price/EPS) = payout_ratio / PE.
 * Null when PE is missing or non-positive (yield is undefined for loss-makers).
 */
export function dividendYieldPctFrom(payoutRatio: number | null, peRatio: number | null): number | null {
  if (payoutRatio === null || peRatio === null || peRatio <= 0) return null;
  return (payoutRatio / peRatio) * 100;
}

/** YoY inventory growth % from balance-sheet rows (newest first). Null unless 2 rows have inventory. */
export function inventoryGrowthPctFromBalances(rows: Raw[]): number | null {
  const [newest, prior] = rows;
  if (!newest || !prior) return null;
  const cur = num(newest["inventory"]);
  const prev = num(prior["inventory"]);
  if (cur === null || prev === null || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Lynch net cash per share: liquid assets minus all debt, per share. Conservative — counts cash +
 * short-term (current) investments only, excluding long-term investments which may be illiquid or
 * equity-method, and subtracts total (not just long-term) debt. Null if cash or shares are missing.
 */
export function netCashPerShareFromBalance(bs: Raw): number | null {
  const shares = num(bs["outstanding_shares"]);
  const cash = num(bs["cash_and_equivalents"]);
  if (shares === null || shares === 0 || cash === null) return null;
  const shortInv = num(bs["current_investments"]) ?? 0;
  const debt = num(bs["total_debt"]) ?? 0;
  return (cash + shortInv - debt) / shares;
}

/**
 * Net insider buying over the window. The API gives no signed shares or buy/sell boolean, so derive
 * direction per trade from the change in shares owned (after − before); fall back to transaction_type
 * when owned-share counts are absent. >0 → net buy. Null when no row yields a usable direction.
 */
export function insiderNetBuyingFromTrades(trades: Raw[]): boolean | null {
  let net = 0;
  let used = 0;
  for (const t of trades) {
    const before = num(t["shares_owned_before_transaction"]);
    const after = num(t["shares_owned_after_transaction"]);
    if (before !== null && after !== null) {
      net += after - before;
      used++;
      continue;
    }
    const type = String(t["transaction_type"] ?? "").toLowerCase();
    const shares = num(t["transaction_shares"]) ?? 0;
    if (type.includes("purchase") || type.includes("buy")) {
      net += shares;
      used++;
    } else if (type.includes("sale") || type.includes("sell")) {
      net -= shares;
      used++;
    }
  }
  return used === 0 ? null : net > 0;
}

/**
 * Isolated mapper — the only place that knows financialdatasets' field names (verified against the
 * live /financial-metrics schema, 2026-06). Notes on derivations:
 *  - No raw `free_cash_flow`; use `free_cash_flow_per_share` (sign check is equivalent).
 *  - No `revenue`; derive salesUsd = market_cap / price_to_sales_ratio.
 *  - No `dividend_yield`; derive from payout_ratio / PE (see dividendYieldPctFrom).
 *  - return_on_equity is a fraction (1.64 = 164%, normal for buyback-heavy names like AAPL).
 *  - inventoryGrowthPct / netCashPerShare / insiderNetBuying enriched from other endpoints (null here).
 */
export function mapMetrics(symbol: string, m: Raw, asOf?: string, history: number[] = []): Fundamentals {
  const marketCap = num(m["market_cap"]);
  const ps = num(m["price_to_sales_ratio"]);
  const salesUsd = marketCap !== null && ps !== null && ps !== 0 ? marketCap / ps : null;
  const peRatio = num(m["price_to_earnings_ratio"]);
  const payoutRatio = num(m["payout_ratio"]);
  return {
    symbol,
    asOf: (m["report_period"] as string | undefined) ?? asOf ?? new Date(0).toISOString(),
    peRatio,
    epsGrowthPct: pct(m["earnings_per_share_growth"]),
    epsGrowthHistoryPct: history,
    dividendYieldPct: dividendYieldPctFrom(payoutRatio, peRatio),
    payoutRatio,
    debtToEquity: num(m["debt_to_equity"]),
    netCashPerShare: null, // enriched from balance sheet
    roePct: pct(m["return_on_equity"]),
    currentRatio: num(m["current_ratio"]),
    freeCashFlow: num(m["free_cash_flow_per_share"]),
    revenueGrowthPct: pct(m["revenue_growth"]),
    inventoryGrowthPct: null, // enriched from balance sheet
    marketCapUsd: marketCap,
    salesUsd,
    institutionalOwnershipPct: null,
    institutionalOwnershipMedianPct: null,
    insiderNetBuying: null, // enriched from insider trades
    fiveYearAvgPe: null,
    earningsCyclicality: null,
    distressed: null,
    hiddenAssetValueToMarketCap: null,
  };
}
