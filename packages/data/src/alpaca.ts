import type { MarketDataAdapter, PriceBar } from "./index.js";
import { withRetry, type RetryOptions } from "./http.js";

/**
 * Alpaca Market Data adapter (stocks). Bars + latest price for the Lynch engine and backtester.
 * Alpaca provides prices/news/corporate-actions but NO fundamentals (use financialdatasets.ai).
 *
 * Endpoints (Basic/IEX free tier, 15-min restriction):
 *   GET {dataUrl}/v2/stocks/{symbol}/bars?timeframe=1Day&start=&end=&feed=iex
 *   GET {dataUrl}/v2/stocks/{symbol}/bars/latest?feed=iex
 *
 * `fetch` injectable for offline testing. Rate limit: 200 req/min on Basic — callers should
 * cache (Redis) and honour 429 + Retry-After.
 */
export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  dataUrl?: string;
  feed?: "iex" | "sip";
  /**
   * Corporate-action adjustment. Alpaca defaults to `raw`, which is CATASTROPHIC for holding
   * returns: a raw series shows AAPL's 2020 4:1 split as $499 -> $129 and NVDA's 2024 10:1 as
   * $1209 -> $122, i.e. a held position takes a fake ~90% loss overnight. SPY has not split since
   * 2005, so a raw benchmark is unaffected while the portfolio is destroyed — the error is
   * ASYMMETRIC and always against the strategy.
   *
   * ⚠️ Use `all`/`split` ONLY for trading and marking. Do NOT feed adjusted prices to valuation
   * ratios built on AS-FILED fundamentals: SEC EPS is in then-current share terms, so an adjusted
   * price over as-filed EPS understates PE by the split factor (AAPL FY2019 would read ~4.2
   * instead of ~17) and makes every pre-split company look absurdly cheap.
   */
  adjustment?: "raw" | "split" | "dividend" | "all";
  fetchImpl?: typeof fetch;
  /** Retry behaviour for 429/5xx (defaults applied). */
  retry?: RetryOptions;
  /** Clock for the recent-SIP guard; injectable for tests. */
  now?: () => number;
}

/**
 * Alpaca Basic serves SIP history only up to 15 minutes ago. Any request whose `end` is later is
 * refused outright with 403 "subscription does not permit querying recent SIP data" — including an
 * ordinary "last year up to now" query — so live research pages lost their prices and the EDGAR
 * adapter's P/E. A one-minute margin covers clock skew.
 */
const SIP_DELAY_MS = 16 * 60_000;

interface RawBar {
  t: string; // RFC-3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

export class AlpacaMarketData implements MarketDataAdapter {
  private readonly dataUrl: string;
  private readonly feed: "iex" | "sip";
  private readonly adjustment: "raw" | "split" | "dividend" | "all";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AlpacaOptions) {
    this.dataUrl = opts.dataUrl ?? "https://data.alpaca.markets";
    this.feed = opts.feed ?? "iex";
    // Default stays `raw` so existing callers (notably valuation) keep their semantics.
    this.adjustment = opts.adjustment ?? "raw";
    // Retry 429/5xx, honouring Retry-After. Without this a rate-limited price fetch THROWS, and
    // the backtest loop catches that as "symbol not yet listed at this clock" — so throttling
    // silently deletes names from a rebalance and the result is wrong with no indication.
    // A wide backtest reliably trips Alpaca's limit, so this is the common case, not an edge one.
    this.fetchImpl = withRetry(opts.fetchImpl ?? fetch, opts.retry);
  }

  /** Latest instant this feed may be queried up to; null when there is no delay (IEX). */
  private sipCutoff(): number | null {
    return this.feed === "sip" ? (this.opts.now ?? Date.now)() - SIP_DELAY_MS : null;
  }

  private headers(): Record<string, string> {
    return { "APCA-API-KEY-ID": this.opts.keyId, "APCA-API-SECRET-KEY": this.opts.secretKey };
  }

  /**
   * Historical bars, FOLLOWING PAGINATION.
   *
   * Alpaca caps a page at 1000 bars and returns `next_page_token`. Ignoring it silently
   * truncated every long request: a 2016->2025 daily query returned bars ending 2024-07-16, so
   * `getLatestPrice` handed back that day's close for EVERY later clock. A backtest therefore
   * marked 18 months of portfolio and benchmark at frozen prices, with no error raised.
   */
  async getBars(symbol: string, from: string, to: string, timeframe = "1Day"): Promise<PriceBar[]> {
    const cutoff = this.sipCutoff();
    if (cutoff !== null && Date.parse(to) > cutoff) to = new Date(cutoff).toISOString();
    const out: PriceBar[] = [];
    let pageToken: string | undefined;
    // Safety valve: bounded so a malformed token cannot spin forever. 100 pages = 100k bars,
    // far beyond any real request here.
    for (let page = 0; page < 100; page++) {
      const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, this.dataUrl);
      url.searchParams.set("timeframe", timeframe);
      url.searchParams.set("start", from);
      url.searchParams.set("end", to);
      url.searchParams.set("feed", this.feed);
      url.searchParams.set("adjustment", this.adjustment);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
      if (!res.ok) throw new Error(`alpaca bars ${symbol}: HTTP ${res.status}`);
      const body = (await res.json()) as { bars?: RawBar[]; next_page_token?: string | null };
      for (const b of body.bars ?? []) {
        out.push({ symbol, ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw });
      }
      if (!body.next_page_token) return out;
      pageToken = body.next_page_token;
    }
    return out;
  }

  async getLatestPrice(symbol: string, asOf?: string): Promise<number> {
    // For a point-in-time clock, the latest endpoint is unsafe (returns "now"); fall back to
    // the last bar at/before asOf so backtests never see the future.
    if (asOf) {
      // Look back a BOUNDED window rather than querying from 2016 to read one price. The old
      // full-history query fetched ~1000 bars to use the last one — wasteful, and it was exactly
      // the request that hit the pagination cap and returned a stale close.
      // Widening steps cover weekends, holidays and long trading halts before giving up.
      for (const lookbackDays of [10, 45, 200]) {
        const start = new Date(Date.parse(asOf) - lookbackDays * 86_400_000).toISOString();
        const bars = await this.getBars(symbol, start, asOf, "1Day");
        const last = bars.at(-1);
        if (last) return last.close;
      }
      throw new Error(`alpaca ${symbol}: no bar as of ${asOf}`);
    }
    // The latest-bar endpoint is "now", which delayed SIP refuses: read the last delayed bar instead.
    const cutoff = this.sipCutoff();
    if (cutoff !== null) return this.getLatestPrice(symbol, new Date(cutoff).toISOString());
    const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars/latest`, this.dataUrl);
    url.searchParams.set("feed", this.feed);
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`alpaca latest ${symbol}: HTTP ${res.status}`);
    const body = (await res.json()) as { bar?: RawBar };
    if (!body.bar) throw new Error(`alpaca ${symbol}: no latest bar`);
    return body.bar.c;
  }
}
