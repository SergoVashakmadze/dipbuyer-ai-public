#!/usr/bin/env node
/**
 * Which checklist criteria actually predict returns? (Step 2 E3)
 *
 * For every decision in a `run-backtest --dump` (criteria are dumped since 2026-09-17), joins the
 * forward excess return vs SPY over a horizon (default 12 rebalances = 12 months) and reports, per
 * criterion, the mean excess of PASS minus FAIL — separately for a TRAIN window (2016-2020) and a
 * TEST window (2021-2025). A criterion earns weight only if its spread is positive in TRAIN; the
 * TEST column is the out-of-sample check that it was not luck.
 *
 * It then scores every decision with TRAIN-derived weights (weight ∝ positive train spread, pass=1,
 * fail=0, n/a excluded and renormalised — the engine's own roll-up rule) and reports the Spearman
 * correlation of that score with forward excess return in both windows, next to the current
 * conviction score. Acceptance for a reweighting: Spearman > 0 in TEST, above the current score.
 *
 *   node apps/api/scripts/criteria-attribution.mjs ~/dipbuyer-runs/<run>.json [--horizon 12] [--split 2021-01-01]
 * Uses prices-cache.json beside the dump (built by attribute-decisions.mjs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dumpPath = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const H = Number(arg("horizon", "12"));
const SPLIT = arg("split", "2021-01-01");
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const cache = JSON.parse(readFileSync(join(dirname(dumpPath), "prices-cache.json"), "utf8"));
const decisions = dump.decisions.filter((d) => Array.isArray(d.criteria));
if (!decisions.length) { console.error("dump has no criteria — rerun with the 2026-09-17 runner"); process.exit(1); }

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

const rows = [];
let missing = 0;
for (const d of decisions) {
  const r = fwd(d.symbol, d.ts), m = fwd("SPY", d.ts);
  if (r === null || m === null) { missing++; continue; }
  rows.push({ ...d, excess: r - m, train: d.ts < SPLIT });
}
const names = [...new Set(rows.flatMap((r) => r.criteria.map((c) => c[0])))].sort();

function spread(sub, name) {
  let ps = 0, pn = 0, fs = 0, fn = 0;
  for (const r of sub) {
    const c = r.criteria.find((x) => x[0] === name);
    if (!c || c[1] === "na") continue;
    if (c[1] === "pass") { ps += r.excess; pn++; } else { fs += r.excess; fn++; }
  }
  return { pass: pn ? ps / pn : null, fail: fn ? fs / fn : null, pn, fn, spread: pn >= 50 && fn >= 50 ? ps / pn - fs / fn : null };
}
const pct = (x) => (x === null ? "—".padStart(9) : `${(x * 100).toFixed(2)}%`.padStart(9));
const train = rows.filter((r) => r.train), test = rows.filter((r) => !r.train);
console.log(`run ${dumpPath}; ${rows.length} decisions with ${H}-month forward returns (${missing} without); split ${SPLIT}`);
console.log(`train ${train.length}, test ${test.length}. Spread = mean excess (PASS) − mean excess (FAIL), vs SPY.\n`);
console.log("criterion".padEnd(26) + "train n(p/f)".padStart(16) + "train spread".padStart(14) + "test n(p/f)".padStart(16) + "test spread".padStart(13) + "  holds OOS?");
const weights = {};
for (const n of names) {
  const a = spread(train, n), b = spread(test, n);
  if (a.spread !== null && a.spread > 0) weights[n] = a.spread;
  const holds = a.spread === null || b.spread === null ? "n/a" : Math.sign(a.spread) === Math.sign(b.spread) ? "yes" : "NO";
  console.log(n.padEnd(26) + `${a.pn}/${a.fn}`.padStart(16) + pct(a.spread).padStart(14) + `${b.pn}/${b.fn}`.padStart(16) + pct(b.spread).padStart(13) + `  ${holds}`);
}

const total = Object.values(weights).reduce((a, b) => a + b, 0);
for (const k of Object.keys(weights)) weights[k] /= total;
function score(r) {
  let w = 0, e = 0;
  for (const [n, res] of r.criteria) {
    if (!(n in weights) || res === "na") continue;
    w += weights[n];
    if (res === "pass") e += weights[n];
  }
  return w ? (e / w) * 100 : null;
}
function spearman(xs, ys) {
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, mean = (a) => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
console.log(`\nTRAIN-derived weights (∝ positive train spread): ${JSON.stringify(Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number(v.toFixed(3))])))}`);
console.log("\nDoes a score rank forward excess return? (Spearman; buy+hold decisions, as the engine allocates)");
console.log("score".padEnd(28) + "train".padStart(10) + "test".padStart(10));
for (const [label, fn] of [["current convictionScore", (r) => r.convictionScore], ["train-weighted criteria", score]]) {
  const out = [];
  for (const sub of [train, test]) {
    const pts = sub.filter((r) => r.verdict === "buy" || r.verdict === "hold").map((r) => [fn(r), r.excess]).filter(([s]) => s !== null && Number.isFinite(s));
    out.push(pts.length > 100 ? spearman(pts.map((p) => p[0]), pts.map((p) => p[1])).toFixed(4) : "—");
  }
  console.log(label.padEnd(28) + out[0].padStart(10) + out[1].padStart(10));
}
writeFileSync(join(dirname(dumpPath), `criteria-weights-h${H}.json`), JSON.stringify({ source: dumpPath, horizon: H, split: SPLIT, weights }, null, 2));
