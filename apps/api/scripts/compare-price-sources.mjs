/**
 * Alpaca vs Polygon/Massive — same symbols, same window, same adjustment — BEFORE any like-for-like
 * backtest rerun. Hits the LIVE APIs (keep out of `pnpm test`).
 *
 *   pnpm build   # the script imports @dipbuyer/data from dist/
 *   node apps/api/scripts/compare-price-sources.mjs \
 *     [--symbols SPY,AAPL,NVDA,SIVB] [--from 2016-01-01] [--to 2025-12-31] [--adjustment all]
 *
 * Env (read from the repo-root .env if present): ALPACA_KEY_ID, ALPACA_SECRET_KEY,
 * ALPACA_DATA_FEED (iex|sip, default iex), POLYGON_API_KEY, POLYGON_BASE_URL (optional).
 * With only one source's keys it reports that source alone; with neither it exits 0 with a message.
 *
 * For each symbol and source it reports: first/last bar date, bar count, total return over the
 * source's OWN span, and — over the dates BOTH sources have — the total return per source, the
 * max and median absolute close difference in basis points (and the date of the max), and how many
 * dates only one source has.
 *
 * Reading it:
 *  - first date: the data FLOOR. HANDOVER.md records Alpaca IEX starting 2021-01-04 and SIP
 *    2016-01-04, and separately that most symbols' first Alpaca bar was in 2020. Check it here.
 *  - SIVB (delisted 2023): does each source still serve a dead ticker? Survivorship depends on it.
 *  - a constant bps gap that jumps at one date = a corporate action the two adjust differently;
 *    a gap that drifts steadily = different dividend treatment (Polygon's `all` is computed in
 *    packages/data/src/polygon.ts, Alpaca's is vendor-side).
 *  - "common-span return" is the like-for-like number; a difference there moves backtest results.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const symbols = arg("symbols", "SPY,AAPL,NVDA,SIVB").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const from = arg("from", "2016-01-01");
const to = arg("to", "2025-12-31");
const adjustment = arg("adjustment", "all");
const feed = process.env.ALPACA_DATA_FEED || "iex";

const haveAlpaca = Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
const havePolygon = Boolean(process.env.POLYGON_API_KEY);
if (!haveAlpaca && !havePolygon) {
  console.log(
    "compare-price-sources: no keys found — set ALPACA_KEY_ID + ALPACA_SECRET_KEY and/or POLYGON_API_KEY " +
      "(in the environment or the repo-root .env). Nothing to compare; exiting.",
  );
  process.exit(0);
}

let data;
try {
  data = await import("@dipbuyer/data");
} catch (e) {
  console.log(`compare-price-sources: could not load @dipbuyer/data (${e.message}). Run \`pnpm build\` first.`);
  process.exit(1);
}
const { AlpacaMarketData, PolygonMarketData } = data;

// Patient retries: Polygon's free tier is 5 req/min and Alpaca Basic 200 req/min. 2s,4s,...,64s.
const retry = { retries: 6, baseDelayMs: 2000 };
const sources = [];
if (haveAlpaca) {
  sources.push({
    name: `alpaca:${feed}`,
    adapter: new AlpacaMarketData({
      keyId: process.env.ALPACA_KEY_ID,
      secretKey: process.env.ALPACA_SECRET_KEY,
      feed,
      adjustment,
      retry,
    }),
  });
} else {
  console.log("(alpaca skipped: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set)");
}
if (havePolygon) {
  sources.push({
    name: "polygon",
    adapter: new PolygonMarketData({
      apiKey: process.env.POLYGON_API_KEY,
      baseUrl: process.env.POLYGON_BASE_URL || undefined,
      adjustment,
      retry,
    }),
  });
} else {
  console.log("(polygon skipped: POLYGON_API_KEY not set)");
}

const day = (ts) => ts.slice(0, 10); // both sources stamp daily bars at midnight ET = 04/05Z, same UTC date
const pct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : NaN);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");

console.log(`window ${from} -> ${to} · adjustment=${adjustment} · sources: ${sources.map((s) => s.name).join(", ")}\n`);

let failures = 0;
for (const symbol of symbols) {
  console.log(`── ${symbol} ${"─".repeat(Math.max(0, 60 - symbol.length))}`);
  const series = [];
  for (const s of sources) {
    try {
      const bars = await s.adapter.getBars(symbol, `${from}T00:00:00Z`, `${to}T23:59:59Z`, "1Day");
      const byDay = new Map(bars.map((b) => [day(b.ts), b.close]));
      series.push({ name: s.name, bars, byDay });
      if (!bars.length) {
        console.log(`  ${s.name.padEnd(12)} NO BARS in window`);
        continue;
      }
      const first = bars[0];
      const last = bars.at(-1);
      console.log(
        `  ${s.name.padEnd(12)} first ${day(first.ts)}  last ${day(last.ts)}  bars ${String(bars.length).padStart(5)}  ` +
          `own-span return ${f2(pct(first.close, last.close))}%`,
      );
    } catch (e) {
      failures++;
      console.log(`  ${s.name.padEnd(12)} ERROR ${e.message}`);
    }
  }

  const [a, b] = series;
  if (series.length === 2 && a.bars.length && b.bars.length) {
    const common = [...a.byDay.keys()].filter((d) => b.byDay.has(d)).sort();
    const onlyA = a.byDay.size - common.length;
    const onlyB = b.byDay.size - common.length;
    if (!common.length) {
      console.log(`  no overlapping dates (${a.name} only: ${onlyA}, ${b.name} only: ${onlyB})`);
    } else {
      const diffs = common.map((d) => ({ d, bps: (Math.abs(a.byDay.get(d) - b.byDay.get(d)) / a.byDay.get(d)) * 10_000 }));
      const max = diffs.reduce((m, x) => (x.bps > m.bps ? x : m));
      const sorted = diffs.map((x) => x.bps).sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      const c0 = common[0];
      const c1 = common.at(-1);
      const retA = pct(a.byDay.get(c0), a.byDay.get(c1));
      const retB = pct(b.byDay.get(c0), b.byDay.get(c1));
      console.log(`  common span  ${c0} -> ${c1}  (${common.length} dates; ${a.name} only ${onlyA}, ${b.name} only ${onlyB})`);
      console.log(`  close diff   max ${max.bps.toFixed(1)} bps on ${max.d} · median ${median.toFixed(1)} bps`);
      console.log(
        `  common-span return  ${a.name} ${f2(retA)}%  ·  ${b.name} ${f2(retB)}%  ·  gap ${f2(retB - retA)} pts`,
      );
    }
  }
  console.log("");
}

if (failures) {
  console.log(
    `${failures} source/symbol fetch(es) failed. HTTP 403 from Polygon on early dates usually means the ` +
      `plan's history limit (Basic 2y, Starter 5y, Developer 10y, Advanced all).`,
  );
  process.exitCode = 1;
}
