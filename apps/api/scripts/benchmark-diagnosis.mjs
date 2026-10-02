#!/usr/bin/env node
/**
 * Where does the gap to SPY come from? Compares a backtest's monthly equity curve with benchmarks
 * that isolate the two structural tilts of the strategy:
 *   SPY  cap-weighted S&P 500 (the headline benchmark)
 *   RSP  EQUAL-weighted S&P 500 (the book is equal-weight, capped)
 *   IVE  S&P 500 Value;  IWD Russell 1000 Value;  VTV Vanguard Value (the screen is value/GARP)
 *
 * Reports buy-and-hold CAGR per benchmark over the same clocks, then regresses the strategy's
 * monthly returns on each (beta, annualised alpha, R², tracking error, information ratio), for the
 * whole window and for two halves (2016-2020 / 2021-2025) so a result can be checked out of sample.
 * Prices: Alpaca adjusted (total return), same series the backtest trades on; cached in prices-cache.json.
 *
 *   node apps/api/scripts/benchmark-diagnosis.mjs ~/dipbuyer-runs/<run>.json   (dump must contain equityCurve)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const dumpPath = process.argv[2];
process.loadEnvFile(new URL("../../../.env", import.meta.url));
const HEADERS = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const FEED = process.env.ALPACA_DATA_FEED || "sip";
const BENCHES = ["SPY", "RSP", "IVE", "IWD", "VTV"];

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const curve = dump.equityCurve;
if (!curve?.length) {
  console.error("dump has no equityCurve — rerun run-backtest.mjs with --dump (equity curve is dumped since 2026-09-16)");
  process.exit(1);
}
const clocks = curve.map((p) => p.ts);
const cachePath = join(dirname(dumpPath), "prices-cache.json");
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

async function bars(symbol) {
  const out = [];
  let token = null;
  do {
    const u = new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`);
    u.searchParams.set("start", "2015-06-01T00:00:00Z");
    u.searchParams.set("end", `${clocks.at(-1).slice(0, 10)}T23:59:59Z`);
    u.searchParams.set("timeframe", "1Day");
    u.searchParams.set("feed", FEED);
    u.searchParams.set("adjustment", "all");
    u.searchParams.set("limit", "10000");
    if (token) u.searchParams.set("page_token", token);
    const res = await fetch(u, { headers: HEADERS });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const body = await res.json();
    for (const b of body.bars ?? []) out.push([b.t, b.c]);
    token = body.next_page_token ?? null;
  } while (token);
  return out;
}
let dirty = false;
for (const s of BENCHES) {
  if (!cache[s] || cache[s][0][0] > "2016-01-01") { cache[s] = await bars(s); dirty = true; }
}
if (dirty) writeFileSync(cachePath, JSON.stringify(cache));

const priceAt = (s, clock) => {
  let best = null;
  for (const [t, c] of cache[s]) { if (t <= clock) best = c; else break; }
  return best;
};
const series = { STRATEGY: curve.map((p) => p.value) };
for (const s of BENCHES) series[s] = clocks.map((c) => priceAt(s, c));

const rets = (xs) => xs.slice(1).map((v, i) => v / xs[i] - 1);
// Periods per year must match the run's rebalance cadence, or a quarterly run is annualised as if
// its 40 clocks were 40 months (seen 2026-09-17: 13.9% CAGR reported as 47.9%).
const PERIODS_PER_YEAR = { daily: 252, weekly: 52, monthly: 12, quarterly: 4, annual: 1 };
const ppy = PERIODS_PER_YEAR[dump.params?.rebalance ?? "monthly"] ?? 12;
const unit = { 252: "days", 52: "weeks", 12: "months", 4: "quarters", 1: "years" }[ppy] ?? "periods";
const cagr = (xs, n) => ((xs.at(-1) / xs[0]) ** (ppy / n) - 1) * 100;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function regress(y, x) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < y.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const beta = sxy / sxx;
  const alphaM = my - beta * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  const active = y.map((v, i) => v - x[i]);
  const te = Math.sqrt(active.reduce((a, v) => a + (v - mean(active)) ** 2, 0) / (active.length - 1)) * Math.sqrt(ppy);
  const ir = (mean(active) * ppy) / te;
  return { beta, alphaAnn: ((1 + alphaM) ** ppy - 1) * 100, r2, te: te * 100, ir };
}

function report(label, from, to) {
  const idx = clocks.map((c, i) => [c, i]).filter(([c]) => c >= from && c <= to).map(([, i]) => i);
  const lo = idx[0], hi = idx.at(-1);
  const n = hi - lo;
  console.log(`\n── ${label}: ${clocks[lo].slice(0, 10)} → ${clocks[hi].slice(0, 10)} (${n} ${unit}) ──`);
  console.log("series".padEnd(10) + "CAGR".padStart(9) + "  | vs strategy:" + "beta".padStart(7) + "alpha/yr".padStart(10) + "R²".padStart(7) + "TE".padStart(8) + "IR".padStart(7));
  const y = rets(series.STRATEGY.slice(lo, hi + 1));
  console.log("STRATEGY".padEnd(10) + `${cagr(series.STRATEGY.slice(lo, hi + 1), n).toFixed(2)}%`.padStart(9));
  for (const s of BENCHES) {
    const xs = series[s].slice(lo, hi + 1);
    if (xs.some((v) => v === null)) { console.log(s.padEnd(10) + "  (unpriced)"); continue; }
    const r = regress(y, rets(xs));
    console.log(s.padEnd(10) + `${cagr(xs, n).toFixed(2)}%`.padStart(9) + "  |" + " ".repeat(13) + r.beta.toFixed(2).padStart(7) + `${r.alphaAnn.toFixed(2)}%`.padStart(10) + r.r2.toFixed(2).padStart(7) + `${r.te.toFixed(1)}%`.padStart(8) + r.ir.toFixed(2).padStart(7));
  }
}
console.log(`run: ${dumpPath}`);
console.log(`alpha = annualised intercept of strategy per-${unit.replace(/s$/, "")} returns on the benchmark (CAPM-style, no risk-free);`);
console.log("IR = annualised active return / tracking error. Positive alpha vs a benchmark = beats it after its beta.");
report("FULL", clocks[0], clocks.at(-1));
report("FIRST HALF", clocks[0], "2020-12-31T23:59:59Z");
report("SECOND HALF", "2021-01-01T00:00:00Z", clocks.at(-1));
