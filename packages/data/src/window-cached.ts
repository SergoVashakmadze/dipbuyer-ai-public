import type { MarketDataAdapter, PriceBar } from "./index.js";

/**
 * Fetches each symbol's bars ONCE for the whole backtest window, then answers every per-clock
 * price and ADV query from memory.
 *
 * A point-in-time universe turns the backtest from ~46 names into ~500 per rebalance. Fetching a
 * price per symbol-per-clock is then ~37,000 Alpaca calls for a three-year monthly run — hours of
 * wall clock, most of it re-requesting bars already seen. One windowed fetch per symbol is ~500.
 * This mirrors what SecEdgarFundamentals already does with companyfacts: pull the whole history
 * once, make the point-in-time cut locally.
 *
 * POINT-IN-TIME DISCIPLINE IS PRESERVED. The cache holds the full window, but every read is cut at
 * the requested clock, exactly as the underlying adapter would. Caching bars is not the same as
 * exposing them.
 */
export class WindowCachedMarketData implements MarketDataAdapter {
  private readonly cache = new Map<string, PriceBar[]>();
  private readonly inflight = new Map<string, Promise<PriceBar[]>>();

  /**
   * @param inner      real adapter (its getBars must already follow pagination)
   * @param windowFrom ISO start of the prefetch window — include enough lead time for the
   *                   longest trailing lookback the caller uses (e.g. the ADV window).
   * @param windowTo   ISO end of the prefetch window.
   * @param maxStalenessDays How far a bar may lag the clock before a price is refused. Guards the
   *   failure mode that froze 18 months of prices: without it, a symbol whose bars STOP mid-window
   *   (delisted, acquired, halted) would keep returning its final close forever, and the position
   *   would be marked at a price that no longer exists. Refusing makes the gap visible instead.
   */
  constructor(
    private readonly inner: MarketDataAdapter,
    private readonly windowFrom: string,
    private readonly windowTo: string,
    private readonly maxStalenessDays = 14,
  ) {}

  /** Bars for the whole window, fetched at most once per symbol even under concurrent calls. */
  private async load(symbol: string): Promise<PriceBar[]> {
    const hit = this.cache.get(symbol);
    if (hit) return hit;
    const pending = this.inflight.get(symbol);
    if (pending) return pending;
    const p = this.inner
      .getBars(symbol, this.windowFrom, this.windowTo, "1Day")
      .then((bars) => {
        const sorted = [...bars].sort((a, b) => (a.ts < b.ts ? -1 : 1));
        this.cache.set(symbol, sorted);
        this.inflight.delete(symbol);
        return sorted;
      })
      .catch((e) => {
        // Do NOT cache failures: a transient 429 would otherwise permanently blank the symbol for
        // the rest of the run, silently deleting it from every later rebalance.
        this.inflight.delete(symbol);
        throw e;
      });
    this.inflight.set(symbol, p);
    return p;
  }

  async getBars(symbol: string, from: string, to: string, timeframe = "1Day"): Promise<PriceBar[]> {
    // Anything outside the prefetched window or off the daily grid has to go to the source —
    // serving it from a day-bar cache would quietly answer a different question than was asked.
    if (timeframe !== "1Day" || from < this.windowFrom || to > this.windowTo) {
      return this.inner.getBars(symbol, from, to, timeframe);
    }
    const bars = await this.load(symbol);
    return bars.filter((b) => b.ts >= from && b.ts <= to);
  }

  async getLatestPrice(symbol: string, asOf?: string): Promise<number> {
    const clock = asOf ?? this.windowTo;
    if (clock < this.windowFrom || clock > this.windowTo) {
      return this.inner.getLatestPrice(symbol, asOf);
    }
    const bars = await this.load(symbol);
    // POINT-IN-TIME: last bar at or before the clock. Never scan forward.
    let latest: PriceBar | undefined;
    for (const b of bars) {
      if (b.ts <= clock) latest = b;
      else break;
    }
    if (!latest) throw new Error(`No price for ${symbol} as of ${clock}`);
    const ageDays = (Date.parse(clock) - Date.parse(latest.ts)) / 86_400_000;
    if (ageDays > this.maxStalenessDays) {
      // Distinguishable from a transport failure by wording — the backtest treats this as
      // "not trading at this clock" (survivorship-safe), not as a broken run.
      throw new Error(
        `No price for ${symbol} as of ${clock}: newest bar is ${latest.ts} ` +
          `(${Math.round(ageDays)}d stale, limit ${this.maxStalenessDays}d) — symbol appears delisted or halted`,
      );
    }
    return latest.close;
  }

  /** Symbols whose window fetch has completed — diagnostics only. */
  cachedSymbols(): string[] {
    return [...this.cache.keys()];
  }
}
