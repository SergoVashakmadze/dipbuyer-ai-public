#!/usr/bin/env node
/**
 * Decision attribution — WHERE does the strategy make and lose money?
 *
 * Joins the decision dump from `run-backtest.mjs --dump` against forward prices and reports
 * excess return vs SPY, sliced by verdict, Lynch category, sector and conviction band.
 *
 * The headline question is the conviction band: the engine computes a 0-100 score and the
 * backtest then ALLOCATES BY IT (M3). If forward returns do not rise with the score, the scoring
 * apparatus — every criterion, weight and threshold in config/strategy.lynch.json — is noise, and
 * no amount of threshold tuning fixes it. That is worth knowing before any more calibration.
 *
 * Forward returns are computed HERE, offline, never inside the backtest: the engine must not be
 * able to see past its own clock. This script is analysis of a finished run, not part of it.
 *
 *   node apps/api/scripts/attribute-decisions.mjs ~/dipbuyer-runs/decisions.json
 *
 * Prices are cached beside the dump, so re-slicing is instant after the first run.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error("usage: attribute-decisions.mjs <decisions.json>");
  process.exit(1);
}
process.loadEnvFile(new URL("../../../.env", import.meta.url));

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SECRET) {
  console.error("ALPACA_KEY_ID / ALPACA_SECRET_KEY required (prices are fetched live).");
  process.exit(1);
}
const HEADERS = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET };
const FEED = process.env.ALPACA_DATA_FEED ?? "sip";

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const decisions = dump.decisions ?? [];
if (!decisions.length) {
  console.error("no decisions in dump — was the run started with --dump?");
  process.exit(1);
}

const clocks = [...new Set(decisions.map((d) => d.ts))].sort();
const nextClock = new Map(clocks.map((c, i) => [c, clocks[i + 1]]));
const symbols = [...new Set(decisions.map((d) => d.symbol))].sort();
const from = clocks[0].slice(0, 10);
const to = clocks.at(-1).slice(0, 10);

const cachePath = join(dirname(dumpPath), "prices-cache.json");
/** symbol -> [[isoTimestamp, close], ...] ascending */
let priceCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

/** ADJUSTED bars: total return, and the same series the backtest traded on. */
async function fetchBars(symbol) {
  const out = [];
  let pageToken = null;
  do {
    const u = new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`);
    u.searchParams.set("start", `${from}T00:00:00Z`);
    u.searchParams.set("end", `${to}T23:59:59Z`);
    u.searchParams.set("timeframe", "1Day");
    u.searchParams.set("feed", FEED);
    u.searchParams.set("adjustment", "all");
    u.searchParams.set("limit", "10000");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const res = await fetch(u, { headers: HEADERS });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!res.ok) return out; // absent/delisted: leave what we have, decisions just go unmatched
    const body = await res.json();
    for (const b of body.bars ?? []) out.push([b.t, b.c]);
    pageToken = body.next_page_token ?? null;
  } while (pageToken);
  return out;
}

const needed = [...symbols, "SPY"].filter((s) => !priceCache[s]);
if (needed.length) {
  process.stderr.write(`fetching prices for ${needed.length} symbols…\n`);
  for (let i = 0; i < needed.length; i++) {
    priceCache[needed[i]] = await fetchBars(needed[i]);
    if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${needed.length}\n`);
  }
  writeFileSync(cachePath, JSON.stringify(priceCache));
  process.stderr.write(`cached -> ${cachePath}\n`);
}

/**
 * Last close at-or-before the clock — the SAME semantics the backtest uses. Bars are stamped in
 * exchange-local time (05:00Z), so a midnight-UTC clock resolves to the previous session's close.
 * Matching this exactly matters: a different convention here would manufacture apparent alpha.
 */
function priceAt(symbol, clock) {
  const bars = priceCache[symbol];
  if (!bars?.length) return null;
  let lo = 0, hi = bars.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid][0] <= clock) { best = bars[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const clockIndex = new Map(clocks.map((c, i) => [c, i]));

/** Forward return over `h` rebalance periods (default 1). Null if the horizon runs off the end. */
function forwardReturn(symbol, clock, h = 1) {
  const i = clockIndex.get(clock);
  if (i === undefined) return null;
  const end = clocks[i + h];
  if (!end) return null;
  const a = priceAt(symbol, clock);
  const b = priceAt(symbol, end);
  if (a === null || b === null || a <= 0) return null;
  return (b - a) / a;
}

/** Spearman rank correlation between two equal-length numeric arrays. */
function spearmanOf(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(arr.length);
    for (let i = 0; i < idx.length; i++) out[idx[i][1]] = i + 1;
    return out;
  };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

const spyFwd = new Map(clocks.map((c) => [c, forwardReturn("SPY", c)]));

const rows = [];
for (const d of decisions) {
  const r = forwardReturn(d.symbol, d.ts);
  const m = spyFwd.get(d.ts);
  if (r === null || m === null || m === undefined) continue;
  rows.push({ ...d, ret: r, excess: r - m });
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
function summarise(label, group) {
  const keys = [...group.keys()].sort();
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`);
  console.log("bucket".padEnd(22) + "n".padStart(8) + "mean ret".padStart(12) + "mean excess".padStart(14) + "beat mkt".padStart(11));
  for (const k of keys) {
    const g = group.get(k);
    const n = g.length;
    const mr = g.reduce((s, x) => s + x.ret, 0) / n;
    const me = g.reduce((s, x) => s + x.excess, 0) / n;
    const win = g.filter((x) => x.excess > 0).length / n;
    console.log(String(k).padEnd(22) + String(n).padStart(8) + pct(mr).padStart(12) + pct(me).padStart(14) + `${(win * 100).toFixed(1)}%`.padStart(11));
  }
}

const by = (fn, subset = rows) => {
  const m = new Map();
  for (const r of subset) {
    const k = fn(r) ?? "(none)";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

console.log(`decisions matched to prices: ${rows.length} / ${decisions.length}`);
console.log(`window ${from} → ${to}, ${clocks.length} clocks`);
console.log(`\nNOTE: "mean excess" is the average ONE-PERIOD forward excess return of the named`);
console.log(`decision vs SPY. It is an equal-weighted per-decision average, NOT the portfolio's`);
console.log(`realised P&L — the book is conviction-weighted and position-capped, so these do not`);
console.log(`sum to the run's return. Use it to compare buckets, not to restate performance.`);
console.log(`\n⚠️  SIGN CONVENTION: these are returns to HOLDING the name. For "buy" and "hold",`);
console.log(`positive excess = a good decision. For "sell" and "avoid" the sign INVERTS —`);
console.log(`a NEGATIVE excess means the name fell after we declined it, i.e. the decision was`);
console.log(`RIGHT. Do not read the avoid/sell rows as underperformance.`);

summarise("BY VERDICT", by((r) => r.verdict));
summarise("BY CONVICTION BAND (buys only)", by(
  (r) => {
    const s = r.convictionScore;
    return s >= 90 ? "90-100" : s >= 80 ? "80-89" : s >= 70 ? "70-79" : s >= 60 ? "60-69" : s >= 50 ? "50-59" : "<50";
  },
  rows.filter((r) => r.verdict === "buy"),
));
summarise("BY LYNCH CATEGORY (buys only)", by((r) => r.category, rows.filter((r) => r.verdict === "buy")));
summarise("BY SECTOR (buys only)", by((r) => r.sector, rows.filter((r) => r.verdict === "buy")));

// The decisive test: does the score carry ANY signal, AT ANY HORIZON? Rank correlation between
// convictionScore and forward excess return, swept over 1/3/6/12 rebalance periods.
//
// The horizon sweep is the point. Lynch is a multi-YEAR method — a value/quality screen is not
// meant to pay off in one month, so a near-zero 1-period correlation does NOT prove the checklist
// is noise. If the correlation RISES with horizon, the edge is real but slow; if it stays ~zero
// out to a year, the checklist genuinely does not discriminate and no threshold tuning fixes it.
//
// Restricted to BUY and HOLD deliberately. Including avoid/sell would invert the sign for half the
// sample (see the convention note above): hard-gated names all score 0, so they would dominate the
// low end of the ranking with returns that SHOULD be high when the decision was right.
console.log(`\n── SIGNAL CHECK — does conviction predict excess return, at any horizon? ──`);
console.log("horizon".padEnd(14) + "n".padStart(8) + "Spearman".padStart(12) + "   verdict");
for (const h of [1, 3, 6, 12, 24, 36, 60, 84, 108, 120]) {
  const scored = rows
    .filter((r) => Number.isFinite(r.convictionScore) && (r.verdict === "buy" || r.verdict === "hold"))
    .map((r) => {
      const stock = forwardReturn(r.symbol, r.ts, h);
      const mkt = forwardReturn("SPY", r.ts, h);
      return stock === null || mkt === null ? null : { s: r.convictionScore, e: stock - mkt };
    })
    .filter(Boolean);
  if (scored.length < 100) { console.log(`${h}m`.padEnd(14) + String(scored.length).padStart(8) + "   (too few)"); continue; }
  const rho = spearmanOf(scored.map((x) => x.s), scored.map((x) => x.e));
  const v = rho > 0.05 ? "signal" : rho < -0.05 ? "BACKWARDS" : "~zero";
  console.log(`${h}m (${h} reb)`.padEnd(14) + String(scored.length).padStart(8) + rho.toFixed(4).padStart(12) + `   ${v}`);
}
console.log("→ If Spearman stays ~zero across ALL horizons, the checklist does not discriminate and");
console.log("  threshold tuning cannot help — the criteria themselves are the problem. If it RISES");
console.log("  with horizon, the edge is real but slow and monthly rebalancing is throwing it away.");
