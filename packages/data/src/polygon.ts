import type { MarketDataAdapter, PriceBar } from "./index.js";
import { withRetry, type RetryOptions } from "./http.js";

/**
 * Polygon.io (rebranded Massive.com, Oct 2025) historical price adapter — a RESEARCH feed, as a
 * like-for-like alternative to Alpaca Basic (IEX live, delayed SIP history: an execution feed).
 *
 * Endpoints (checked against https://massive.com/docs, 2026-09-16):
 *   GET {baseUrl}/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
 *       ?adjusted=true|false&sort=asc&limit=50000        -> results[].{t,o,h,l,c,v,vw}, next_url
 *   GET {baseUrl}/stocks/v1/dividends?ticker=&limit=5000&sort=ex_dividend_date.asc
 *       -> results[].{ex_dividend_date, cash_amount, split_adjusted_cash_amount, currency, ...}
 *       (supersedes the now-deprecated /v3/reference/dividends)
 *
 * Host: `https://api.massive.com` is the documented base. `https://api.polygon.io` still answers
 * (both returned "Unknown API Key" for a dummy key on 2026-09-16, i.e. both parse auth) and the
 * vendor says both run in parallel "for an extended period". Override with `baseUrl`.
 *
 * Auth: `Authorization: Bearer <key>` on EVERY request, including `next_url` pages. `next_url` does
 * not carry the key, so a page fetched without re-attaching it 401s. The header is used rather than
 * `?apiKey=` so the key never lands in a URL (logs, error messages, caches keyed by URL).
 *
 * PLAN HISTORY LIMITS (docs, per plan): aggregates Basic 2y, Starter 5y, Developer 10y, Advanced
 * all history (floor 2003-09-10). A 2016-01 start in late 2026 needs more than 10 years, so on
 * Developer the earliest bars are refused or missing — run compare-price-sources.mjs first.
 *
 * ── Adjustment modes, matched to AlpacaOptions.adjustment ────────────────────────────────────────
 *  raw       adjusted=false
 *  split     adjusted=true
 *  dividend  adjusted=false  + dividend back-adjustment (cash_amount over raw closes)
 *  all       adjusted=true   + dividend back-adjustment (split_adjusted_cash_amount over split-
 *                              adjusted closes)
 *
 * DOCS FINDING: Polygon's `adjusted=true` is SPLITS ONLY. The custom-bars reference says "Whether or
 * not the results are adjusted for splits … Set this to false to get results that are NOT adjusted
 * for splits", and says nothing about dividends; dividends are published separately, with their own
 * `historical_adjustment_factor`. So `adjusted=true` alone is NOT equivalent to Alpaca
 * `adjustment=all` — using it would drop ~1.5-2%/yr of SPY's return from the benchmark AND from
 * every dividend payer in the book. `all` therefore back-adjusts dividends here, explicitly.
 *
 * Dividend back-adjustment (standard price-ratio method, as CRSP/Yahoo-style adjusted closes): for
 * each cash dividend with ex-date E, every bar dated before E is multiplied by (1 - D / C), where C is
 * the close on the last trading day before E, and D and C are in the SAME share basis. Factors
 * compound across dividends. Volume is not dividend-adjusted. Alpaca does not publish its exact
 * dividend formula; this is the conventional one, and compare-price-sources.mjs measures any gap.
 * (The vendor's own `historical_adjustment_factor` on the dividends endpoint is an independent
 * cross-check of the same quantity; it is not used so the math stays inspectable and testable.)
 *
 * ANCHORING: factors run from each bar to the PRESENT (every known dividend after the bar), not to
 * the end of the requested window. That makes a bar's adjusted value independent of the window it
 * was requested in — essential, because the backtest reads the same symbol through different windows
 * (window prefetch, 10-day latest-price lookbacks, 90-day ADV) and a window-relative factor would
 * put those reads on different scales, inventing returns. Same as Alpaca: adjusted LEVELS embed
 * later corporate actions, adjusted RETURNS do not (point-in-time safe for returns; the $1 price
 * floor and ADV gate see present-anchored levels on both sources alike).
 */
export type PolygonAdjustment = "raw" | "split" | "dividend" | "all";

export interface PolygonOptions {
  apiKey: string;
  /** Default https://api.massive.com (https://api.polygon.io also works). */
  baseUrl?: string;
  /** Default `raw`, mirroring AlpacaMarketData, so valuation callers keep as-filed semantics. */
  adjustment?: PolygonAdjustment;
  fetchImpl?: typeof fetch;
  /** Retry behaviour for 429/5xx (defaults applied). */
  retry?: RetryOptions;
  /** Injectable clock for getLatestPrice() without asOf (tests). */
  now?: () => number;
}

interface RawAgg {
  t: number; // Unix ms, START of the aggregate window (daily bars: midnight America/New_York)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

interface RawDividend {
  ex_dividend_date?: string;
  cash_amount?: number;
  split_adjusted_cash_amount?: number;
  currency?: string;
}

interface Dividend {
  exDate: string; // YYYY-MM-DD
  /** Summed per ex-date (a regular + a special on the same day compound as one event). */
  cash: number;
  splitAdjustedCash: number;
}

const DAY_MS = 86_400_000;
const MAX_PAGES = 100;

const etDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Exchange-local calendar date of a bar (YYYY-MM-DD). Ex-dividend dates are exchange-local too. */
function etDay(ms: number): string {
  return etDate.format(new Date(ms));
}

/**
 * Epoch ms -> the exact string shape Alpaca returns ("2020-01-02T05:00:00Z", no millis).
 * WindowCachedMarketData and the backtest compare `ts` AS STRINGS against clocks, so both sources
 * must emit one sortable format or a source switch would silently reorder bars against clocks.
 */
export function polygonTs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** Alpaca-style timeframe ("1Day", "5Min", "1Hour") -> Polygon multiplier + timespan. */
function parseTimeframe(timeframe: string): { multiplier: number; timespan: string } {
  const m = /^(\d+)(Min|T|Hour|H|Day|D|Week|W|Month|M)$/.exec(timeframe);
  if (!m) throw new Error(`polygon: unsupported timeframe "${timeframe}"`);
  const unit = m[2]!;
  const timespan =
    unit === "Min" || unit === "T"
      ? "minute"
      : unit === "Hour" || unit === "H"
        ? "hour"
        : unit === "Day" || unit === "D"
          ? "day"
          : unit === "Week" || unit === "W"
            ? "week"
            : "month";
  return { multiplier: Number(m[1]), timespan };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class PolygonMarketData implements MarketDataAdapter {
  private readonly baseUrl: string;
  private readonly adjustment: PolygonAdjustment;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** symbol -> dividend history (whole history, one request per symbol per instance). */
  private readonly dividendCache = new Map<string, Promise<Dividend[]>>();
  /** symbol -> exDate -> close on the last trading day before exDate (null = not applicable). */
  private readonly prevCloseCache = new Map<string, Map<string, number | null>>();

  constructor(private readonly opts: PolygonOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.massive.com").replace(/\/+$/, "");
    this.adjustment = opts.adjustment ?? "raw";
    // Same reasoning as AlpacaMarketData: a throttled fetch that THROWS is read by the backtest as
    // "not listed at this clock" unless retried. Polygon's free tier is 5 req/min, so 429 is common.
    this.fetchImpl = withRetry(opts.fetchImpl ?? fetch, opts.retry);
    this.now = opts.now ?? Date.now;
  }

  private get splitAdjusted(): boolean {
    return this.adjustment === "split" || this.adjustment === "all";
  }

  private get dividendAdjusted(): boolean {
    return this.adjustment === "dividend" || this.adjustment === "all";
  }

  /**
   * GET a Polygon URL with auth, following `next_url` pagination.
   *
   * `next_url` is resolved against OUR base origin: the bearer token is only ever sent to the host
   * the caller configured, even if a page link names a different one (e.g. api.massive.com links
   * returned while talking to api.polygon.io).
   */
  private async getPaged<T>(firstUrl: string, label: string): Promise<T[]> {
    const out: T[] = [];
    let url = firstUrl;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
      if (!res.ok) {
        // "HTTP nnn" is the shape run.ts's isTransportFailure keys on — keep it exact.
        let detail = "";
        try {
          const body = (await res.json()) as { status?: string; error?: string; message?: string };
          const msg = body?.error ?? body?.message;
          if (msg) detail = ` (${body.status ? `${body.status}: ` : ""}${msg})`;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`${label}: HTTP ${res.status}${detail}`);
      }
      const body = (await res.json()) as { results?: T[]; next_url?: string | null; status?: string; error?: string };
      if (body.status === "ERROR") {
        throw new Error(`${label}: HTTP ${res.status} (ERROR: ${body.error ?? "unspecified"})`);
      }
      out.push(...(body.results ?? []));
      if (!body.next_url) return out;
      const next = new URL(body.next_url, this.baseUrl);
      url = `${this.baseUrl}${next.pathname}${next.search}`;
    }
    return out;
  }

  /** Raw aggregates in [from, to] (inclusive, by bar START time), ascending. */
  private async fetchAggs(symbol: string, fromMs: number, toMs: number, timeframe: string): Promise<RawAgg[]> {
    const { multiplier, timespan } = parseTimeframe(timeframe);
    // Request by calendar DATE, widened a day each side, then cut client-side on the exact epoch.
    // The daily bar for day D starts at 04:00/05:00Z on D, so a date-granular server window alone
    // would return the bar for `to`'s date even when `to` is midnight UTC — i.e. before that bar
    // exists. That is a one-day look-ahead; the client-side cut is what enforces point-in-time.
    const url =
      `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/` +
      `${utcDay(fromMs - DAY_MS)}/${utcDay(toMs + DAY_MS)}` +
      `?adjusted=${this.splitAdjusted}&sort=asc&limit=50000`;
    const rows = await this.getPaged<RawAgg>(url, `polygon bars ${symbol}`);
    return rows.filter((r) => r.t >= fromMs && r.t <= toMs).sort((a, b) => a.t - b.t);
  }

  private dividends(symbol: string): Promise<Dividend[]> {
    const hit = this.dividendCache.get(symbol);
    if (hit) return hit;
    const url =
      `${this.baseUrl}/stocks/v1/dividends?ticker=${encodeURIComponent(symbol)}` +
      `&limit=5000&sort=ex_dividend_date.asc`;
    const p = this.getPaged<RawDividend>(url, `polygon dividends ${symbol}`)
      .then((rows) => {
        const byDate = new Map<string, Dividend>();
        for (const r of rows) {
          if (!r.ex_dividend_date || !(Number(r.cash_amount) > 0)) continue;
          // A non-USD amount cannot be divided by a USD close. Rare for US listings; skipped rather
          // than mis-scaled.
          if (r.currency && r.currency !== "USD") continue;
          const cash = Number(r.cash_amount);
          const splitAdj = Number(r.split_adjusted_cash_amount) > 0 ? Number(r.split_adjusted_cash_amount) : cash;
          const cur = byDate.get(r.ex_dividend_date);
          if (cur) {
            cur.cash += cash;
            cur.splitAdjustedCash += splitAdj;
          } else {
            byDate.set(r.ex_dividend_date, { exDate: r.ex_dividend_date, cash, splitAdjustedCash: splitAdj });
          }
        }
        return [...byDate.values()].sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
      })
      .catch((e) => {
        // Never cache a failure: a transient 429 would otherwise drop dividends for the whole run.
        this.dividendCache.delete(symbol);
        throw e;
      });
    this.dividendCache.set(symbol, p);
    return p;
  }

  /**
   * Record prev-closes for any `pending` ex-dates that `dailyBars` can answer. A bar series answers
   * ex-date E only when it contains a bar ON/AFTER E and a bar before it — otherwise the last bar
   * before E in this series is not necessarily the last TRADING day before E.
   */
  private resolvePrevCloses(dailyBars: RawAgg[], pending: string[], cache: Map<string, number | null>): void {
    for (const exDate of pending) {
      if (cache.has(exDate)) continue;
      const idx = dailyBars.findIndex((b) => etDay(b.t) >= exDate);
      if (idx > 0) cache.set(exDate, dailyBars[idx - 1]!.c);
    }
  }

  /** Per-dividend factors (ascending ex-date) that apply to any bar dated on/after `firstDay`. */
  private async dividendFactors(
    symbol: string,
    firstDay: string,
    dailyBars: RawAgg[] | null,
  ): Promise<Array<{ exDate: string; factor: number }>> {
    const divs = (await this.dividends(symbol)).filter((d) => d.exDate > firstDay);
    if (!divs.length) return [];
    let cache = this.prevCloseCache.get(symbol);
    if (!cache) {
      cache = new Map();
      this.prevCloseCache.set(symbol, cache);
    }
    let pending = divs.map((d) => d.exDate).filter((e) => !cache!.has(e));
    if (pending.length && dailyBars) this.resolvePrevCloses(dailyBars, pending, cache);
    pending = pending.filter((e) => !cache!.has(e));
    if (pending.length) {
      // One extra request covers every ex-date the caller's window could not answer (typically all
      // dividends AFTER the window — see ANCHORING in the header).
      const lo = Date.parse(`${pending[0]}T00:00:00Z`) - 30 * DAY_MS;
      const hi = Date.parse(`${pending.at(-1)}T23:59:59Z`) + 10 * DAY_MS;
      const bars = await this.fetchAggs(symbol, lo, Math.min(hi, this.now()), "1Day");
      this.resolvePrevCloses(bars, pending, cache);
      // Still unresolved = no bar before the ex-date (pre-listing) or none on/after it (future or
      // post-delisting ex-date). Neither adjusts any price we can serve.
      for (const e of pending) if (!cache.has(e)) cache.set(e, null);
    }
    const out: Array<{ exDate: string; factor: number }> = [];
    for (const d of divs) {
      const prevClose = cache.get(d.exDate);
      if (prevClose == null || !(prevClose > 0)) continue;
      const amount = this.splitAdjusted ? d.splitAdjustedCash : d.cash;
      const factor = 1 - amount / prevClose;
      // A dividend >= the price is bad data, not a corporate action — never zero/flip the series.
      if (!(factor > 0 && factor < 1)) continue;
      out.push({ exDate: d.exDate, factor });
    }
    return out;
  }

  /** Historical bars, adjusted per `adjustment`, in [from, to] by bar start time, ascending. */
  async getBars(symbol: string, from: string, to: string, timeframe = "1Day"): Promise<PriceBar[]> {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new Error(`polygon bars ${symbol}: invalid window ${from}..${to}`);
    const rows = await this.fetchAggs(symbol, fromMs, toMs, timeframe);

    let factors: Array<{ exDate: string; factor: number }> = [];
    if (this.dividendAdjusted && rows.length) {
      const daily = timeframe === "1Day" || timeframe === "1D" ? rows : null;
      factors = await this.dividendFactors(symbol, etDay(rows[0]!.t), daily);
    }
    // cumulative[i] = product of factors[i..end] — the multiplier for a bar dated before factors[i].
    const cumulative = new Array<number>(factors.length + 1).fill(1);
    for (let i = factors.length - 1; i >= 0; i--) cumulative[i] = cumulative[i + 1]! * factors[i]!.factor;

    let k = 0;
    return rows.map((r) => {
      const day = etDay(r.t);
      while (k < factors.length && factors[k]!.exDate <= day) k++;
      const f = cumulative[k]!;
      return {
        symbol,
        ts: polygonTs(r.t),
        open: r.o * f,
        high: r.h * f,
        low: r.l * f,
        close: r.c * f,
        volume: r.v,
        vwap: r.vw === undefined ? undefined : r.vw * f,
      };
    });
  }

  async getLatestPrice(symbol: string, asOf?: string): Promise<number> {
    // Same bounded, widening lookback as AlpacaMarketData, and the same "no bar as of" wording —
    // run.ts treats that shape as "not trading at this clock", distinct from an HTTP failure.
    const clock = asOf ?? new Date(this.now()).toISOString();
    for (const lookbackDays of [10, 45, 200]) {
      const start = new Date(Date.parse(clock) - lookbackDays * DAY_MS).toISOString();
      const bars = await this.getBars(symbol, start, clock, "1Day");
      const last = bars.at(-1);
      if (last) return last.close;
    }
    throw new Error(asOf ? `polygon ${symbol}: no bar as of ${asOf}` : `polygon ${symbol}: no latest bar`);
  }
}
