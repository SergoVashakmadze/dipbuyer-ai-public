import { describe, expect, it, vi } from "vitest";
import { PolygonMarketData, polygonTs, type PolygonAdjustment } from "./polygon.js";
import { WindowCachedMarketData } from "./window-cached.js";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as Response;

/** Mirror of packages/backtest/src/run.ts isTransportFailure — the message contract this adapter must honour. */
const TRANSPORT = /HTTP \d{3}|fetch failed|ECONN|ETIMEDOUT|socket|network/i;

const noSleep = { sleep: async () => {} };

/** Epoch ms of midnight America/New_York on an ET calendar day (how Polygon stamps daily bars). */
function etMidnight(day: string): number {
  for (const h of [4, 5]) {
    const t = Date.parse(`${day}T0${h}:00:00Z`);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(t);
    if (hour === "00") return t;
  }
  throw new Error(`bad day ${day}`);
}

interface Day {
  day: string;
  /** split-adjusted close */
  adj: number;
  /** raw (as-traded) close */
  raw: number;
}

/**
 * Hand-checked fixture. A 4:1 split happened AFTER these bars, so raw prices are 4x the
 * split-adjusted ones and raw dividends are 4x the split-adjusted amounts.
 *
 *   ex 2020-02-07: split-adj $2 over prev close $100 -> factor 0.98   (raw: $8 / $400 = 0.02, same)
 *   ex 2020-05-08: split-adj $1 over prev close $50  -> factor 0.98   (raw: $4 / $200, same)
 *
 * adjustment=all closes:
 *   2020-02-06  100 x 0.98 x 0.98 = 96.04   (before both ex-dates)
 *   2020-02-07  102 x 0.98        = 99.96   (on first ex-date: only the later dividend applies)
 *   2020-05-07   50 x 0.98        = 49.00
 *   2020-05-08   49               = 49.00   (on/after the last ex-date: unadjusted)
 */
const DAYS: Day[] = [
  { day: "2020-02-06", adj: 100, raw: 400 },
  { day: "2020-02-07", adj: 102, raw: 408 },
  { day: "2020-05-07", adj: 50, raw: 200 },
  { day: "2020-05-08", adj: 49, raw: 196 },
];
const DIVIDENDS = [
  { ticker: "XYZ", ex_dividend_date: "2020-02-07", cash_amount: 8, split_adjusted_cash_amount: 2, currency: "USD" },
  { ticker: "XYZ", ex_dividend_date: "2020-05-08", cash_amount: 4, split_adjusted_cash_amount: 1, currency: "USD" },
  // Declared but not yet effective (no bar on/after it) — must not adjust anything.
  { ticker: "XYZ", ex_dividend_date: "2099-01-02", cash_amount: 40, split_adjusted_cash_amount: 10, currency: "USD" },
];

/** URL-routing fake of the two Polygon endpoints, honouring the aggs date window and `adjusted`. */
function fakePolygon(days: Day[] = DAYS, dividends: unknown[] = DIVIDENDS) {
  return vi.fn(async (input: string, _init?: RequestInit) => {
    const u = new URL(input);
    if (u.pathname.startsWith("/stocks/v1/dividends")) return jsonResponse({ status: "OK", results: dividends });
    const m = /\/v2\/aggs\/ticker\/([^/]+)\/range\/1\/day\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (!m) return jsonResponse({ status: "ERROR", error: "not found" }, 404);
    const [, , from, to] = m;
    const adjusted = u.searchParams.get("adjusted") === "true";
    const results = days
      .filter((d) => d.day >= from! && d.day <= to!)
      .map((d) => {
        const c = adjusted ? d.adj : d.raw;
        return { t: etMidnight(d.day), o: c, h: c, l: c, c, v: 1000, vw: c };
      });
    return jsonResponse({ status: "OK", adjusted, results });
  });
}

const make = (adjustment: PolygonAdjustment, fetchImpl: ReturnType<typeof fakePolygon>) =>
  new PolygonMarketData({ apiKey: "secret", adjustment, fetchImpl: fetchImpl as unknown as typeof fetch, retry: noSleep, now: () => Date.parse("2026-09-16T00:00:00Z") });

const WINDOW = ["2020-02-01T00:00:00Z", "2020-05-31T00:00:00Z"] as const;

describe("PolygonMarketData timestamps", () => {
  it("emits the exact Alpaca ts shape (no millis), for EST and EDT bars", () => {
    expect(polygonTs(1577941200000)).toBe("2020-01-02T05:00:00Z"); // Polygon docs sample, EST
    expect(polygonTs(Date.UTC(2020, 6, 6, 4))).toBe("2020-07-06T04:00:00Z"); // EDT
  });

  it("returns bars whose ts sort and compare correctly inside WindowCachedMarketData (point-in-time)", async () => {
    const days: Day[] = [
      { day: "2020-01-02", adj: 10, raw: 10 },
      { day: "2020-01-03", adj: 11, raw: 11 },
    ];
    const poly = make("split", fakePolygon(days, []));
    const cached = new WindowCachedMarketData(poly, "2019-12-01T00:00:00.000Z", "2020-01-31T00:00:00.000Z");
    // A midnight-UTC clock on Jan 3 sits BEFORE Jan 3's 05:00Z bar -> must resolve to Jan 2's close.
    expect(await cached.getLatestPrice("XYZ", "2020-01-03T00:00:00.000Z")).toBe(10);
    expect(await cached.getLatestPrice("XYZ", "2020-01-03T06:00:00.000Z")).toBe(11);
    // Pre-existing string-compare quirk, identical for Alpaca-shaped ts: a clock EXACTLY at the bar
    // time with millis ("…05:00:00.000Z") sorts BEFORE "…05:00:00Z" ('.' < 'Z'), so that bar is not
    // yet visible. Harmless for midnight-UTC schedules; pinned here so a format change is noticed.
    expect(await cached.getLatestPrice("XYZ", "2020-01-03T05:00:00.000Z")).toBe(10);
  });

  it("cuts the window client-side so a date-granular server response cannot leak the next bar", async () => {
    const days: Day[] = [
      { day: "2020-01-02", adj: 10, raw: 10 },
      { day: "2020-01-03", adj: 11, raw: 11 },
    ];
    const poly = make("raw", fakePolygon(days, []));
    const bars = await poly.getBars("XYZ", "2020-01-01T00:00:00Z", "2020-01-03T00:00:00Z", "1Day");
    expect(bars.map((b) => b.ts)).toEqual(["2020-01-02T05:00:00Z"]);
    expect(await poly.getLatestPrice("XYZ", "2020-01-03T00:00:00Z")).toBe(10);
  });
});

describe("PolygonMarketData requests", () => {
  it("uses the daily aggs endpoint with limit=50000, sort=asc, bearer auth and no key in the URL", async () => {
    const f = fakePolygon();
    await make("raw", f).getBars("XYZ", ...WINDOW, "1Day");
    expect(f).toHaveBeenCalledTimes(1); // raw: no dividends call
    const [url, init] = f.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/api\.massive\.com\/v2\/aggs\/ticker\/XYZ\/range\/1\/day\/2020-01-31\/2020-06-01\?/);
    expect(url).toContain("adjusted=false");
    expect(url).toContain("limit=50000");
    expect(url).toContain("sort=asc");
    expect(url).not.toContain("secret");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("follows next_url, re-attaching auth and pinning it to the configured host", async () => {
    const t1 = etMidnight("2020-01-02");
    const t2 = etMidnight("2020-01-03");
    const f = vi.fn(async (input: string, _init?: RequestInit) =>
      input.includes("cursor=")
        ? jsonResponse({ status: "OK", results: [{ t: t2, o: 2, h: 2, l: 2, c: 2, v: 1 }] })
        : jsonResponse({
            status: "OK",
            results: [{ t: t1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
            // Links name the new brand host even when the caller talks to the old one.
            next_url: "https://api.massive.com/v2/aggs/ticker/XYZ/range/1/day/1578027600000/2020-01-04?cursor=abc",
          }),
    );
    const poly = new PolygonMarketData({ apiKey: "secret", baseUrl: "https://api.polygon.io", adjustment: "split", fetchImpl: f as unknown as typeof fetch, retry: noSleep });
    const bars = await poly.getBars("XYZ", "2020-01-01T00:00:00Z", "2020-01-04T00:00:00Z");
    expect(bars.map((b) => b.close)).toEqual([1, 2]);
    expect(f).toHaveBeenCalledTimes(2);
    const [page2Url, page2Init] = f.mock.calls[1]!;
    expect(page2Url).toBe("https://api.polygon.io/v2/aggs/ticker/XYZ/range/1/day/1578027600000/2020-01-04?cursor=abc");
    expect((page2Init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("retries 429 and then succeeds", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ status: "ERROR", error: "rate limited" }, 429, { "retry-after": "0" });
      return jsonResponse({ status: "OK", results: [{ t: etMidnight("2020-01-02"), o: 5, h: 5, l: 5, c: 5, v: 1 }] });
    });
    const poly = new PolygonMarketData({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, retry: noSleep });
    expect(await poly.getLatestPrice("XYZ", "2020-01-03T00:00:00Z")).toBe(5);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("PolygonMarketData error messages (run.ts contract)", () => {
  it("HTTP failure -> 'HTTP nnn', classified as TRANSPORT, with the vendor reason and no key", async () => {
    const f = vi.fn(async () => jsonResponse({ status: "NOT_AUTHORIZED", message: "Your plan doesn't include this data timeframe." }, 403));
    const poly = new PolygonMarketData({ apiKey: "secret", fetchImpl: f as unknown as typeof fetch, retry: noSleep });
    const err = await poly.getBars("XYZ", ...WINDOW).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "polygon bars XYZ: HTTP 403 (NOT_AUTHORIZED: Your plan doesn't include this data timeframe.)",
    );
    expect(TRANSPORT.test((err as Error).message)).toBe(true);
    expect((err as Error).message).not.toContain("secret");
  });

  it("gives up after the retry budget on persistent 429 with an HTTP 429 message", async () => {
    const f = vi.fn(async () => jsonResponse({}, 429));
    const poly = new PolygonMarketData({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, retry: { ...noSleep, retries: 2 } });
    await expect(poly.getLatestPrice("XYZ", "2020-01-03T00:00:00Z")).rejects.toThrow(/HTTP 429/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("no data -> 'no bar as of', classified as MISSING PRICE (not transport), after the widening lookback", async () => {
    const f = vi.fn(async () => jsonResponse({ status: "OK", resultsCount: 0 }));
    const poly = new PolygonMarketData({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, retry: noSleep });
    const err = await poly.getLatestPrice("SIVB", "2024-01-02T00:00:00Z").catch((e: Error) => e);
    expect((err as Error).message).toBe("polygon SIVB: no bar as of 2024-01-02T00:00:00Z");
    expect(TRANSPORT.test((err as Error).message)).toBe(false);
    expect(f).toHaveBeenCalledTimes(3); // 10, 45, 200-day lookbacks
  });

  it("a dividends-endpoint failure under adjustment=all surfaces as transport, not a silent unadjusted series", async () => {
    const f = vi.fn(async (input: string) =>
      input.includes("/stocks/v1/dividends")
        ? jsonResponse({ status: "ERROR", error: "boom" }, 500)
        : jsonResponse({ status: "OK", results: [{ t: etMidnight("2020-02-06"), o: 1, h: 1, l: 1, c: 1, v: 1 }] }),
    );
    const poly = new PolygonMarketData({ apiKey: "k", adjustment: "all", fetchImpl: f as unknown as typeof fetch, retry: { ...noSleep, retries: 0 } });
    await expect(poly.getBars("XYZ", ...WINDOW)).rejects.toThrow(/^polygon dividends XYZ: HTTP 500/);
  });
});

describe("PolygonMarketData adjustment math (hand-checked, see DAYS)", () => {
  it("raw: adjusted=false, as-traded prices, no dividend call", async () => {
    const f = fakePolygon();
    const bars = await make("raw", f).getBars("XYZ", ...WINDOW);
    expect(bars.map((b) => b.close)).toEqual([400, 408, 200, 196]);
    expect(f.mock.calls.some(([u]) => u.includes("dividends"))).toBe(false);
  });

  it("split: adjusted=true, split-adjusted only — dividends are NOT folded in", async () => {
    const f = fakePolygon();
    const bars = await make("split", f).getBars("XYZ", ...WINDOW);
    expect(f.mock.calls[0]![0]).toContain("adjusted=true");
    expect(bars.map((b) => b.close)).toEqual([100, 102, 50, 49]);
    expect(f.mock.calls.some(([u]) => u.includes("dividends"))).toBe(false);
  });

  it("all: split-adjusted closes x cumulative (1 - splitAdjDiv / prevClose) for every later ex-date", async () => {
    const f = fakePolygon();
    const bars = await make("all", f).getBars("XYZ", ...WINDOW);
    const closes = bars.map((b) => b.close);
    expect(closes[0]).toBeCloseTo(96.04, 10);
    expect(closes[1]).toBeCloseTo(99.96, 10);
    expect(closes[2]).toBeCloseTo(49, 10);
    expect(closes[3]).toBe(49);
    // OHLC and VWAP scale together; volume does not.
    expect(bars[0]!.open).toBeCloseTo(96.04, 10);
    expect(bars[0]!.vwap).toBeCloseTo(96.04, 10);
    expect(bars[0]!.volume).toBe(1000);
    // The ratio method's defining identity: the adjusted one-day return ACROSS an ex-date equals
    // P1 / (P0 - D) — 102 / (100 - 2) — i.e. the dividend is treated as reinvested at the prior close.
    // (A hair above the cash total return (P1 + D) / P0 = 1.04. Alpaca does not document its exact
    // dividend formula, so apps/api/scripts/compare-price-sources.mjs measures the gap on real data.)
    expect(closes[1]! / closes[0]!).toBeCloseTo(102 / (100 - 2), 12);
    expect(closes[3]! / closes[2]!).toBeCloseTo(49 / (50 - 1), 12);
  });

  it("all uses split_adjusted_cash_amount (raw cash over split-adjusted price would over-adjust 4x)", async () => {
    const bars = await make("all", fakePolygon()).getBars("XYZ", ...WINDOW);
    // Had cash_amount (8) been used over the split-adjusted $100, the factor would be 0.92, not 0.98.
    expect(bars[1]!.close).not.toBeCloseTo(102 * 0.96, 2);
    expect(bars[1]!.close).toBeCloseTo(99.96, 10);
  });

  it("dividend: raw closes x (1 - cash / rawPrevClose) — same factors, as-traded basis", async () => {
    const bars = await make("dividend", fakePolygon()).getBars("XYZ", ...WINDOW);
    const closes = bars.map((b) => b.close);
    expect(closes[0]).toBeCloseTo(400 * 0.98 * 0.98, 10); // 384.16
    expect(closes[1]).toBeCloseTo(408 * 0.98, 10); // 399.84
    expect(closes[2]).toBeCloseTo(196, 10);
    expect(closes[3]).toBe(196);
  });

  it("anchors factors to the PRESENT: a narrow window still applies dividends after it (same scale as a wide read)", async () => {
    const f = fakePolygon();
    const poly = make("all", f);
    const narrow = await poly.getBars("XYZ", "2020-02-01T00:00:00Z", "2020-02-29T00:00:00Z");
    expect(narrow.map((b) => b.close)[0]).toBeCloseTo(96.04, 10);
    expect(narrow.map((b) => b.close)[1]).toBeCloseTo(99.96, 10);
    // One extra aggs call resolved the May ex-date's previous close.
    const aggCalls = f.mock.calls.filter(([u]) => u.includes("/v2/aggs/"));
    expect(aggCalls).toHaveLength(2);
    // Cached thereafter: a second read costs one aggs call, no dividend or prev-close refetch.
    const before = f.mock.calls.length;
    const wide = await poly.getBars("XYZ", ...WINDOW);
    expect(f.mock.calls.length - before).toBe(1);
    expect(wide[0]!.close).toBeCloseTo(narrow[0]!.close, 10);
  });

  it("ignores non-USD and non-positive dividends and sums same-day distributions", async () => {
    const divs = [
      { ex_dividend_date: "2020-02-07", cash_amount: 4, split_adjusted_cash_amount: 1, currency: "USD" },
      { ex_dividend_date: "2020-02-07", cash_amount: 4, split_adjusted_cash_amount: 1, currency: "USD" }, // special, same day
      { ex_dividend_date: "2020-05-08", cash_amount: 4, split_adjusted_cash_amount: 1, currency: "CAD" },
      { ex_dividend_date: "2020-05-07", cash_amount: 0, currency: "USD" },
    ];
    const bars = await make("all", fakePolygon(DAYS, divs)).getBars("XYZ", ...WINDOW);
    expect(bars.map((b) => b.close)[0]).toBeCloseTo(100 * 0.98, 10); // (1+1)/100 once; CAD skipped
    expect(bars.map((b) => b.close)[2]).toBe(50);
  });
});
