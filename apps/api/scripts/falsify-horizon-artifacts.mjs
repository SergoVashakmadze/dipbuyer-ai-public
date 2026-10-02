#!/usr/bin/env node
/**
 * Falsification battery for the "conviction signal doubles at 5y" finding (#16186 / #16189).
 * Reconstructs attribute-decisions.mjs exactly, then attacks the 60m Spearman from every angle:
 * coverage forensics, time-confound (within-month), overlap/ESS (symbol bootstrap, unique-symbol),
 * aggregation mechanics (sqrt-h scaling, non-overlapping increments), tie-handling, beta drift,
 * cohort effects, survivorship probes. Offline: uses the existing prices-cache.json only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "dipbuyer-runs");
const dump = JSON.parse(readFileSync(join(DIR, "decisions.json"), "utf8"));
const cache = JSON.parse(readFileSync(join(DIR, "prices-cache.json"), "utf8"));
const decisions = dump.decisions ?? [];

const clocks = [...new Set(decisions.map((d) => d.ts))].sort();
const clockIndex = new Map(clocks.map((c, i) => [c, i]));
const N = clocks.length;

// ---- price access (identical semantics to attribute-decisions.mjs, but returns [ts, px]) ----
function barAt(symbol, clock) {
  const bars = cache[symbol];
  if (!bars?.length) return null;
  let lo = 0, hi = bars.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid][0] <= clock) { best = bars[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
const px = (s, c) => { const b = barAt(s, c); return b ? b[1] : null; };

function fwd(symbol, clock, h = 1) {
  const i = clockIndex.get(clock);
  if (i === undefined) return null;
  const end = clocks[i + h];
  if (!end) return null;
  const a = px(symbol, clock), b = px(symbol, end);
  if (a === null || b === null || a <= 0) return null;
  return (b - a) / a;
}

// ---- Spearman: their version (tie-break by array order) and proper (average ranks) ----
function rankTheirs(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length; i++) out[idx[i][1]] = i + 1;
  return out;
}
function rankAvg(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}
function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
const spearTheirs = (xs, ys) => pearson(rankTheirs(xs), rankTheirs(ys));
const spearAvg = (xs, ys) => pearson(rankAvg(xs), rankAvg(ys));

// deterministic RNG for bootstrap
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f2 = (x) => (x * 100).toFixed(2) + "%";
const f4 = (x) => x.toFixed(4);

// =====================================================================================
console.log("========== S0. CACHE / COVERAGE FORENSICS ==========");
const symStats = [];
let empty = 0;
for (const [s, bars] of Object.entries(cache)) {
  if (!bars?.length) { empty++; symStats.push({ s, n: 0 }); continue; }
  symStats.push({ s, n: bars.length, first: bars[0][0].slice(0, 10), last: bars.at(-1)[0].slice(0, 10) });
}
console.log(`cache symbols: ${symStats.length}, empty (no bars at all): ${empty}`);
console.log(`SPY: ${cache.SPY?.[0]?.[0]?.slice(0, 10)} -> ${cache.SPY?.at(-1)?.[0]?.slice(0, 10)} (${cache.SPY?.length} bars)`);
const firstYearHist = {};
for (const st of symStats) if (st.n) firstYearHist[st.first.slice(0, 4)] = (firstYearHist[st.first.slice(0, 4)] || 0) + 1;
console.log("first-bar year histogram (non-empty symbols):", firstYearHist);
const lastYearHist = {};
for (const st of symStats) if (st.n) lastYearHist[st.last.slice(0, 4)] = (lastYearHist[st.last.slice(0, 4)] || 0) + 1;
console.log("last-bar year histogram:", lastYearHist);

// matched fraction by entry year for scored buy/hold
const scoredAll = decisions.filter((d) => Number.isFinite(d.convictionScore) && (d.verdict === "buy" || d.verdict === "hold"));
const matchYear = {};
for (const d of scoredAll) {
  const y = d.ts.slice(0, 4);
  matchYear[y] ??= { tot: 0, m: 0 };
  matchYear[y].tot++;
  if (fwd(d.symbol, d.ts, 1) !== null && fwd("SPY", d.ts, 1) !== null) matchYear[y].m++;
}
console.log("\nscored buy/hold: matched-to-prices fraction by ENTRY year:");
for (const y of Object.keys(matchYear).sort()) {
  const { tot, m } = matchYear[y];
  console.log(`  ${y}: ${m}/${tot} (${((m / tot) * 100).toFixed(0)}%)`);
}

// =====================================================================================
console.log("\n========== S1. REPRODUCE PUBLISHED SWEEP (sanity) ==========");
const spy1 = new Map(clocks.map((c) => [c, fwd("SPY", c, 1)]));
const rows = [];
for (const d of decisions) {
  const r = fwd(d.symbol, d.ts, 1);
  const m = spy1.get(d.ts);
  if (r === null || m === null || m === undefined) continue;
  rows.push({ ...d, i: clockIndex.get(d.ts) });
}
console.log(`decisions matched: ${rows.length} / ${decisions.length}  (published: 30510 / 54587)`);
const scored = rows.filter((r) => Number.isFinite(r.convictionScore) && (r.verdict === "buy" || r.verdict === "hold"));

function sweepSample(h) {
  const out = [];
  for (const r of scored) {
    const stock = fwd(r.symbol, r.ts, h);
    const mkt = fwd("SPY", r.ts, h);
    if (stock === null || mkt === null) continue;
    out.push({ ...r, e: stock - mkt });
  }
  return out;
}
const HS = [1, 3, 6, 12, 24, 36, 60];
const samples = new Map(HS.map((h) => [h, sweepSample(h)]));
console.log("h     n      rho(theirs)  rho(avg-ranks)   rho(1)*sqrt(h)");
const rho1theirs = spearTheirs(samples.get(1).map((x) => x.convictionScore), samples.get(1).map((x) => x.e));
for (const h of HS) {
  const s = samples.get(h);
  const rt = spearTheirs(s.map((x) => x.convictionScore), s.map((x) => x.e));
  const ra = spearAvg(s.map((x) => x.convictionScore), s.map((x) => x.e));
  console.log(`${String(h).padEnd(4)} ${String(s.length).padStart(6)}   ${f4(rt).padStart(9)}   ${f4(ra).padStart(11)}   ${f4(rho1theirs * Math.sqrt(h)).padStart(12)}`);
}

// =====================================================================================
console.log("\n========== S2. 60m SAMPLE ANATOMY ==========");
const s60 = samples.get(60);
const entryHist = {};
for (const r of s60) { const k = r.ts.slice(0, 7); entryHist[k] = (entryHist[k] || 0) + 1; }
console.log("entry-month histogram of the n=" + s60.length + " sample:");
for (const k of Object.keys(entryHist).sort()) console.log(`  ${k}: ${entryHist[k]}`);
const sym60 = new Set(s60.map((r) => r.symbol));
console.log(`distinct symbols in 60m sample: ${sym60.size}`);
const perSym = {};
for (const r of s60) perSym[r.symbol] = (perSym[r.symbol] || 0) + 1;
const top = Object.entries(perSym).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log("most-repeated symbols:", top.map(([s, n]) => `${s}:${n}`).join(" "));

// frozen-at-end (delisted mid-window): end bar >45d older than end clock
let frozen = 0; const frozenScores = [], liveScores = [];
for (const r of s60) {
  const end = clocks[r.i + 60];
  const b = barAt(r.symbol, end);
  const gapDays = (new Date(end) - new Date(b[0])) / 86400000;
  if (gapDays > 45) { frozen++; frozenScores.push(r.convictionScore); } else liveScores.push(r.convictionScore);
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
console.log(`frozen-price (delisted/halted >45d before window end): ${frozen}/${s60.length}`);
console.log(`  mean score frozen=${mean(frozenScores).toFixed(1)} vs live=${mean(liveScores).toFixed(1)}`);

// time-confound direct measurement on the pooled 60m sample
console.log(`Spearman(entry clock index, excess60) = ${f4(spearAvg(s60.map((r) => r.i), s60.map((r) => r.e)))}`);
console.log(`Spearman(entry clock index, score)    = ${f4(spearAvg(s60.map((r) => r.i), s60.map((r) => r.convictionScore)))}`);
// SPY 60m forward per entry month present in sample
const spyByMonth = {};
for (const k of Object.keys(entryHist).sort()) {
  const c = clocks.find((cc) => cc.slice(0, 7) === k);
  spyByMonth[k] = fwd("SPY", c, 60);
}
console.log("SPY 60m fwd by entry month:", Object.fromEntries(Object.entries(spyByMonth).map(([k, v]) => [k, v === null ? null : f2(v)])));

// =====================================================================================
console.log("\n========== S3. WITHIN-ENTRY-MONTH (Fama-MacBeth) CROSS-SECTIONAL SPEARMAN ==========");
function withinMonth(sample, minN = 20) {
  const byClock = new Map();
  for (const r of sample) {
    if (!byClock.has(r.i)) byClock.set(r.i, []);
    byClock.get(r.i).push(r);
  }
  const rhos = [];
  for (const [i, g] of [...byClock.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length < minN) continue;
    rhos.push({ i, month: clocks[i].slice(0, 7), n: g.length, rho: spearAvg(g.map((x) => x.convictionScore), g.map((x) => x.e)) });
  }
  return rhos;
}
for (const h of [1, 12, 36, 60]) {
  const rhos = withinMonth(samples.get(h));
  const vals = rhos.map((r) => r.rho);
  const m = mean(vals);
  const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2)));
  const pos = vals.filter((v) => v > 0).length;
  console.log(`h=${String(h).padEnd(3)} months=${String(vals.length).padStart(3)}  mean-rho=${f4(m)}  sd=${f4(sd)}  months>0: ${pos}/${vals.length}  naiveSE=${f4(sd / Math.sqrt(vals.length))}  (overlap => far fewer independent draws)`);
  if (h === 60) for (const r of rhos) console.log(`    ${r.month}  n=${String(r.n).padStart(4)}  rho=${f4(r.rho)}`);
}

// =====================================================================================
console.log("\n========== S4. NON-OVERLAPPING INCREMENTS (the decisive slow-edge test) ==========");
// Does conviction predict the return earned in years 2,3,4,5 — or only year 1 compounding?
// Within-month cross-sections; entries restricted to the 60m-eligible set for comparability.
const elig = scored.filter((r) => r.i + 60 < N);
function incrementSample(a, b) {
  const out = [];
  for (const r of elig) {
    const ca = clocks[r.i + a], cb = clocks[r.i + b];
    const sa = barAt(r.symbol, ca), sb = barAt(r.symbol, cb);
    if (!sa || !sb || sa[1] <= 0) continue;
    if (sa[0] === sb[0]) continue; // fully frozen segment (delisted before it began)
    const ma = px("SPY", ca), mb = px("SPY", cb);
    const rs = (sb[1] - sa[1]) / sa[1], rm = (mb - ma) / ma;
    out.push({ ...r, e: rs - rm });
  }
  return out;
}
console.log("window        n      pooled-rho   within-month mean-rho (months, >0)");
for (const [a, b] of [[0, 12], [12, 24], [24, 36], [36, 48], [48, 60]]) {
  const s = incrementSample(a, b);
  const pooled = spearAvg(s.map((x) => x.convictionScore), s.map((x) => x.e));
  const rhos = withinMonth(s);
  const vals = rhos.map((r) => r.rho);
  const pos = vals.filter((v) => v > 0).length;
  console.log(`m${String(a).padStart(2)}-m${String(b).padEnd(4)} ${String(s.length).padStart(6)}   ${f4(pooled).padStart(9)}    ${f4(mean(vals)).padStart(8)}  (${vals.length}, ${pos}>0)`);
}

// =====================================================================================
console.log("\n========== S5. EFFECTIVE SAMPLE SIZE: UNIQUE-SYMBOL + SYMBOL-BLOCK BOOTSTRAP ==========");
// one obs per symbol (first eligible entry)
const firstBySym = new Map();
for (const r of s60) if (!firstBySym.has(r.symbol) || r.i < firstBySym.get(r.symbol).i) firstBySym.set(r.symbol, r);
const uniq = [...firstBySym.values()];
console.log(`unique-symbol (first entry) n=${uniq.length}  rho=${f4(spearAvg(uniq.map((r) => r.convictionScore), uniq.map((r) => r.e)))}`);
// symbol-block bootstrap on pooled 60m rho
const symList = [...sym60];
const bySymRows = new Map(symList.map((s) => [s, s60.filter((r) => r.symbol === s)]));
const rng = mulberry32(20260722);
const boots = [];
for (let b = 0; b < 2000; b++) {
  const xs = [], ys = [];
  for (let k = 0; k < symList.length; k++) {
    const pick = symList[Math.floor(rng() * symList.length)];
    for (const r of bySymRows.get(pick)) { xs.push(r.convictionScore); ys.push(r.e); }
  }
  boots.push(spearAvg(xs, ys));
}
boots.sort((a, b) => a - b);
console.log(`symbol-block bootstrap (2000 reps) of pooled 60m rho: 2.5%=${f4(boots[49])}  50%=${f4(boots[999])}  97.5%=${f4(boots[1949])}`);
const fracNeg = boots.filter((v) => v <= 0).length / boots.length;
console.log(`fraction of bootstrap reps with rho <= 0: ${(fracNeg * 100).toFixed(1)}%`);

// =====================================================================================
console.log("\n========== S6. BETA / MARKET-DRIFT CHANNEL ==========");
// per-symbol beta from monthly clock returns (fresh bars only)
function monthlyReturns(sym) {
  const out = [];
  for (let i = 0; i + 1 < N; i++) {
    const a = barAt(sym, clocks[i]), b = barAt(sym, clocks[i + 1]);
    if (!a || !b || a[0] === b[0] || a[1] <= 0) { out.push(null); continue; }
    out.push((b[1] - a[1]) / a[1]);
  }
  return out;
}
const spyM = monthlyReturns("SPY");
const betas = new Map();
for (const s of sym60) {
  const rm = monthlyReturns(s);
  const xs = [], ys = [];
  for (let i = 0; i < rm.length; i++) if (rm[i] !== null && spyM[i] !== null) { xs.push(spyM[i]); ys.push(rm[i]); }
  if (xs.length < 24) continue;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, varx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); varx += (xs[i] - mx) ** 2; }
  betas.set(s, cov / varx);
}
const withBeta = s60.filter((r) => betas.has(r.symbol));
console.log(`betas estimated for ${betas.size}/${sym60.size} symbols (>=24 months)`);
console.log(`Spearman(score, beta) on 60m sample: ${f4(spearAvg(withBeta.map((r) => r.convictionScore), withBeta.map((r) => betas.get(r.symbol))))}`);
// beta-adjusted 60m excess
const adj = withBeta.map((r) => {
  const R = fwd(r.symbol, r.ts, 60), M = fwd("SPY", r.ts, 60);
  return { ...r, e: R - betas.get(r.symbol) * M };
});
console.log(`60m rho raw (same subset):    ${f4(spearAvg(withBeta.map((r) => r.convictionScore), withBeta.map((r) => r.e)))}`);
console.log(`60m rho beta-adjusted:        ${f4(spearAvg(adj.map((r) => r.convictionScore), adj.map((r) => r.e)))}`);
const wmAdj = withinMonth(adj);
console.log(`60m beta-adjusted within-month mean-rho: ${f4(mean(wmAdj.map((r) => r.rho)))} (${wmAdj.length} months)`);

// =====================================================================================
console.log("\n========== S7. COHORT CONTROL: 12m SIGNAL, EARLY vs LATE ENTRIES ==========");
const s12 = samples.get(12);
const early12 = s12.filter((r) => r.i + 60 < N);        // the 60m-eligible cohort
const late12 = s12.filter((r) => r.i + 60 >= N);
for (const [label, s] of [["60m-eligible cohort", early12], ["later cohort       ", late12]]) {
  const rhos = withinMonth(s);
  const vals = rhos.map((r) => r.rho);
  console.log(`${label}: n=${String(s.length).padStart(6)}  pooled=${f4(spearAvg(s.map((x) => x.convictionScore), s.map((x) => x.e)))}  within-month mean=${f4(mean(vals))} (${vals.length} months)`);
}

// =====================================================================================
console.log("\n========== S8. SURVIVORSHIP PROBES ==========");
// (a) eligible-but-unmatched: scored buy/hold entries at i<=61 that never joined the sample
const eligAll = scoredAll.filter((d) => { const i = clockIndex.get(d.ts); return i !== undefined && i + 60 < N; });
const matchedKey = new Set(s60.map((r) => r.ts + "|" + r.symbol));
const un = eligAll.filter((d) => !matchedKey.has(d.ts + "|" + d.symbol));
console.log(`60m-eligible scored buy/hold: ${eligAll.length}; in sample: ${s60.length}; dropped: ${un.length}`);
console.log(`  mean score: dropped=${mean(un.map((d) => d.convictionScore)).toFixed(1)} vs sample=${mean(s60.map((r) => r.convictionScore)).toFixed(1)}`);
const unSym = new Set(un.map((d) => d.symbol));
const unEmpty = [...unSym].filter((s) => !cache[s]?.length);
console.log(`  dropped rows span ${unSym.size} symbols; ${unEmpty.length} of those have ZERO price bars (fully invisible to attribution)`);
// (b) sensitivity: frozen names' excess floored/ceilinged
function rhoWithFrozenImputed(val) {
  const xs = [], ys = [];
  for (const r of s60) {
    const end = clocks[r.i + 60];
    const b = barAt(r.symbol, end);
    const gapDays = (new Date(end) - new Date(b[0])) / 86400000;
    xs.push(r.convictionScore);
    ys.push(gapDays > 45 ? val : r.e);
  }
  return spearAvg(xs, ys);
}
console.log(`  60m rho if all frozen names imputed to -100% excess: ${f4(rhoWithFrozenImputed(-1))}`);
console.log(`  60m rho if all frozen names imputed to +50% excess:  ${f4(rhoWithFrozenImputed(0.5))}`);
