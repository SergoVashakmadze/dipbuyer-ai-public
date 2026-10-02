import { describe, expect, it, vi } from "vitest";
import type { MarketDataAdapter, PriceBar } from "./index.js";
import { WindowCachedMarketData } from "./window-cached.js";

const bar = (ts: string, close: number): PriceBar => ({
  symbol: "AAA",
  ts,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1_000_000,
});

/** Adapter that counts calls, so we can assert the cache actually prevents refetching. */
function countingAdapter(bars: PriceBar[]): MarketDataAdapter & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async getBars(_symbol, from, to) {
      calls++;
      return bars.filter((b) => b.ts >= from && b.ts <= to);
    },
    async getLatestPrice(_symbol, asOf) {
      calls++;
      const eligible = bars.filter((b) => !asOf || b.ts <= asOf);
      const last = eligible.at(-1);
      if (!last) throw new Error("no bars");
      return last.close;
    },
  } as MarketDataAdapter & { calls: () => number };
}

const WINDOW_FROM = "2023-01-01T00:00:00Z";
const WINDOW_TO = "2023-12-31T00:00:00Z";

describe("WindowCachedMarketData", () => {
  const daily: PriceBar[] = [
    bar("2023-01-02T00:00:00Z", 10),
    bar("2023-02-01T00:00:00Z", 12),
    bar("2023-03-01T00:00:00Z", 14),
  ];

  it("fetches each symbol ONCE however many clocks are queried", async () => {
    const inner = countingAdapter(daily);
    const md = new WindowCachedMarketData(inner, WINDOW_FROM, WINDOW_TO);
    for (const clock of ["2023-01-15", "2023-02-15", "2023-03-15"]) {
      await md.getLatestPrice("AAA", `${clock}T00:00:00Z`);
    }
    // The whole point: 3 clocks (and in a real run, 37) cost one windowed fetch.
    expect(inner.calls()).toBe(1);
  });

  it("never returns a price from the FUTURE of the clock", async () => {
    // The cache holds the full window, so this is the guarantee most at risk from caching.
    const md = new WindowCachedMarketData(countingAdapter(daily), WINDOW_FROM, WINDOW_TO);
    expect(await md.getLatestPrice("AAA", "2023-01-15T00:00:00Z")).toBe(10); // not 12 or 14
    expect(await md.getLatestPrice("AAA", "2023-02-15T00:00:00Z")).toBe(12); // not 14
  });

  it("REFUSES a stale price rather than freezing the last close", async () => {
    // This is bug #1's shape: Alpaca pagination was dropped, prices stopped mid-window, and
    // getLatestPrice returned that final close for every later clock — 18 months of frozen
    // prices in portfolio AND benchmark. A cache makes that failure easier to reintroduce, so
    // the staleness bound is the guard. A delisted name must read as absent, not as flat.
    const md = new WindowCachedMarketData(countingAdapter(daily), WINDOW_FROM, WINDOW_TO, 14);
    await expect(md.getLatestPrice("AAA", "2023-06-01T00:00:00Z")).rejects.toThrow(/stale|delisted/i);
    // ...but a price just inside the bound is still served.
    await expect(md.getLatestPrice("AAA", "2023-03-10T00:00:00Z")).resolves.toBe(14);
  });

  it("does not cache a failure — a transient error must not blank the symbol for the run", async () => {
    // Caching the empty result of a 429 would silently delete the name from every later
    // rebalance, which is exactly how throttling used to masquerade as delisting.
    let attempt = 0;
    const flaky: MarketDataAdapter = {
      async getBars() {
        attempt++;
        if (attempt === 1) throw new Error("alpaca bars AAA: HTTP 429");
        return daily;
      },
      async getLatestPrice() {
        throw new Error("unused");
      },
    };
    const md = new WindowCachedMarketData(flaky, WINDOW_FROM, WINDOW_TO);
    await expect(md.getLatestPrice("AAA", "2023-03-01T00:00:00Z")).rejects.toThrow(/429/);
    // Second attempt must actually retry the source, not serve a cached blank.
    await expect(md.getLatestPrice("AAA", "2023-03-01T00:00:00Z")).resolves.toBe(14);
  });

  it("coalesces concurrent first-touches into ONE fetch", async () => {
    const inner = countingAdapter(daily);
    const md = new WindowCachedMarketData(inner, WINDOW_FROM, WINDOW_TO);
    await Promise.all([
      md.getLatestPrice("AAA", "2023-03-01T00:00:00Z"),
      md.getLatestPrice("AAA", "2023-03-01T00:00:00Z"),
      md.getBars("AAA", WINDOW_FROM, "2023-03-01T00:00:00Z"),
    ]);
    expect(inner.calls()).toBe(1);
  });

  it("delegates queries outside the prefetched window instead of answering from cache", async () => {
    // Answering an out-of-window question from a window cache would quietly return a different
    // answer than the source would.
    const inner = countingAdapter(daily);
    const md = new WindowCachedMarketData(inner, WINDOW_FROM, WINDOW_TO);
    await md.getBars("AAA", "2020-01-01T00:00:00Z", "2020-06-01T00:00:00Z");
    await md.getBars("AAA", WINDOW_FROM, "2023-06-01T00:00:00Z", "1Hour");
    expect(inner.calls()).toBe(2); // both delegated, neither served from the day-bar cache
  });

  it("serves getBars slices from the same single fetch", async () => {
    const inner = countingAdapter(daily);
    const md = new WindowCachedMarketData(inner, WINDOW_FROM, WINDOW_TO);
    const slice = await md.getBars("AAA", WINDOW_FROM, "2023-02-01T00:00:00Z");
    expect(slice.map((b) => b.close)).toEqual([10, 12]);
    await md.getLatestPrice("AAA", "2023-03-01T00:00:00Z");
    expect(inner.calls()).toBe(1);
  });
});
