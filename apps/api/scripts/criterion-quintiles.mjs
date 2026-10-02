#!/usr/bin/env node
/**
 * Does a criterion's RAW VALUE rank forward returns? (Step 2 conviction signals)
 *
 * criteria-attribution.mjs judges a criterion by its pass/fail split at one threshold. A threshold
 * picked a priori can hide a real monotone signal (or manufacture one), so this sorts every
 * decision with a numeric value for the criterion into quintiles PER CLOCK (cross-sectional, so a
 * market-wide level shift in the value does not masquerade as signal) and reports mean forward
 * excess return vs SPY per quintile, Q5−Q1 and the Spearman correlation, in TRAIN and TEST.
 * Acceptance mirrors the pass/fail rule: Q5−Q1 and Spearman the same sign in both windows.
 *
 *   node apps/api/scripts/criterion-quintiles.mjs ~/dipbuyer-runs/<run>.json --criterion ebit_ev [--horizon 12] [--split 2021-01-01] [--buy-hold]
 * Uses prices-cache.json beside the dump (built by attribute-decisions.mjs).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dumpPath = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const NAME = arg("criterion", null);
const H = Number(arg("horizon", "12"));
const SPLIT = arg("split", "2021-01-01");
const buyHold = process.argv.includes("--buy-hold");
if (!dumpPath || !NAME) { console.error("usage: criterion-quintiles.mjs <dump.json> --criterion <name>"); process.exit(1); }

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const cache = JSON.parse(readFileSync(join(dirname(dumpPath), "prices-cache.json"), "utf8"));
const clocks = [...new Set(dump.decisions.map((d) => d.ts))].sort();
const at = new Map(clocks.map((c, i) => [c, i]));
function priceAt(sym, clock) {
  const bars = cache[sym];
  if (!bars?.length) return null;
  let lo = 0, hi = bars.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m][0] <= clock) { best = bars[m][1]; lo = m + 1; } else hi = m - 1; }
  return best;
}
function fwd(sym, clock) {
  const end = clocks[at.get(clock) + H];
  if (!end) return null;
  const a = priceAt(sym, clock), b = priceAt(sym, end);
  return a && b ? b / a - 1 : null;
}

let withCriterion = 0, numeric = 0, noReturn = 0;
const byClock = new Map();
for (const d of dump.decisions) {
  if (buyHold && d.verdict !== "buy" && d.verdict !== "hold") continue;
  const c = Array.isArray(d.criteria) && d.criteria.find((x) => x[0] === NAME);
  if (!c) continue;
  withCriterion++;
  if (typeof c[2] !== "number" || !Number.isFinite(c[2])) continue;
  numeric++;
  const r = fwd(d.symbol, d.ts), m = fwd("SPY", d.ts);
  if (r === null || m === null) { noReturn++; continue; }
  if (!byClock.has(d.ts)) byClock.set(d.ts, []);
  byClock.get(d.ts).push({ value: c[2], excess: r - m });
}

const buckets = { train: [[], [], [], [], []], test: [[], [], [], [], []] };
const pairs = { train: [], test: [] };
for (const [ts, rows] of byClock) {
  if (rows.length < 10) continue; // too few names on this clock to rank
  rows.sort((a, b) => a.value - b.value);
  const win = ts < SPLIT ? "train" : "test";
  rows.forEach((r, i) => {
    buckets[win][Math.min(4, Math.floor((i / rows.length) * 5))].push(r);
    pairs[win].push(r);
  });
}
function spearman(xs, ys) {
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, mean = (a) => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const mean = (a, k) => (a.length ? a.reduce((s, r) => s + r[k], 0) / a.length : null);
const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(2)}%`);

console.log(`run ${dumpPath}; criterion ${NAME}; ${H}-month forward excess vs SPY; split ${SPLIT}${buyHold ? "; buy+hold only" : ""}`);
console.log(`${withCriterion} decisions carry ${NAME}, ${numeric} with a numeric value, ${noReturn} without a forward return\n`);
console.log("quintile (low → high value)".padEnd(30) + "train n".padStart(9) + "train excess".padStart(14) + "train value".padStart(13) + "test n".padStart(9) + "test excess".padStart(13) + "test value".padStart(12));
for (let q = 0; q < 5; q++) {
  const a = buckets.train[q], b = buckets.test[q];
  const med = (rows) => (rows.length ? rows.map((r) => r.value).sort((x, y) => x - y)[rows.length >> 1].toFixed(3) : "—");
  console.log(`Q${q + 1}`.padEnd(30) + String(a.length).padStart(9) + pct(mean(a, "excess")).padStart(14) + med(a).padStart(13) + String(b.length).padStart(9) + pct(mean(b, "excess")).padStart(13) + med(b).padStart(12));
}
const spreadOf = (w) => (buckets[w][4].length && buckets[w][0].length ? mean(buckets[w][4], "excess") - mean(buckets[w][0], "excess") : null);
const rho = (w) => (pairs[w].length > 100 ? spearman(pairs[w].map((p) => p.value), pairs[w].map((p) => p.excess)) : null);
console.log("\n" + "Q5 − Q1".padEnd(30) + pct(spreadOf("train")).padStart(23) + pct(spreadOf("test")).padStart(47));
console.log("Spearman(value, excess)".padEnd(30) + (rho("train")?.toFixed(4) ?? "—").padStart(23) + (rho("test")?.toFixed(4) ?? "—").padStart(47));
const s = [spreadOf("train"), spreadOf("test"), rho("train"), rho("test")];
console.log(`\nconsistent sign in both windows: ${s.includes(null) ? "n/a" : Math.sign(s[0]) === Math.sign(s[1]) && Math.sign(s[2]) === Math.sign(s[3]) && Math.sign(s[0]) === Math.sign(s[2]) ? "yes" : "NO"}`);
