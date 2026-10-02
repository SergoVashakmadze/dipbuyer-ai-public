#!/usr/bin/env node
/**
 * SPY core + DipBuyer satellite (E1): what a blend of the index and the strategy would have
 * returned, per satellite weight, rebalanced back to target at every clock of the run.
 *
 *   node apps/api/scripts/core-satellite.mjs ~/dipbuyer-runs/<run>.json [--weights 0,20,30,50,70,100] [--split 2021-01-01]
 *        [--write-web apps/web/lib/core-satellite.ts --label "strategy v0.4.2"]   regenerate the agent page's table
 *
 * Uses the run's equity curve and the SPY prices benchmark-diagnosis.mjs cached next to the dump
 * (run that first). SPY is priced at the last close at or before each clock, the backtest's own
 * convention. No extra friction is charged for the rebalance: the drift between two monthly clocks
 * is small, and the strategy's own trading costs are already inside its curve.
 * CAGR here is over ACTUAL elapsed time (first to last clock); run-backtest's metric counts clocks/12,
 * so both columns read ~0.2 pts higher here than there. Differences between rows are unaffected.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const dumpPath = process.argv[2];
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const weights = arg("weights", "0,20,30,50,70,100").split(",").map(Number);
const split = arg("split", "2021-01-01");

const curve = JSON.parse(readFileSync(dumpPath, "utf8")).equityCurve;
const cachePath = join(dirname(dumpPath), "prices-cache.json");
if (!existsSync(cachePath)) throw new Error(`no ${cachePath}: run benchmark-diagnosis.mjs on this dump first`);
const spyBars = JSON.parse(readFileSync(cachePath, "utf8")).SPY;

const priceAt = (ts) => {
  let px = null;
  for (const [t, c] of spyBars) {
    if (t > ts) break;
    px = c;
  }
  if (px === null) throw new Error(`no SPY price at or before ${ts}`);
  return px;
};
const spy = curve.map((p) => priceAt(p.ts));
const periodsPerYear = curve.length > 1 ? (curve.length - 1) / ((Date.parse(curve.at(-1).ts) - Date.parse(curve[0].ts)) / (365.25 * 86_400_000)) : 12;

function stats(from, to) {
  const idx = curve.map((p, i) => i).filter((i) => curve[i].ts >= from && curve[i].ts < to);
  const rS = [], rB = [];
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k], j = idx[k - 1];
    rS.push(curve[i].value / curve[j].value - 1);
    rB.push(spy[i] / spy[j] - 1);
  }
  const years = rS.length / periodsPerYear;
  const rows = [];
  for (const w of weights) {
    const r = rS.map((s, k) => (w / 100) * s + (1 - w / 100) * rB[k]);
    let v = 1, peak = 1, dd = 0;
    for (const x of r) {
      v *= 1 + x;
      peak = Math.max(peak, v);
      dd = Math.max(dd, 1 - v / peak);
    }
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    const active = r.map((x, k) => x - rB[k]);
    const am = active.reduce((a, b) => a + b, 0) / active.length;
    const te = Math.sqrt(active.reduce((a, b) => a + (b - am) ** 2, 0) / Math.max(1, active.length - 1)) * Math.sqrt(periodsPerYear);
    rows.push({ w, cagr: (v ** (1 / years) - 1) * 100, dd: dd * 100, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0, te: te * 100 });
  }
  const spyCagr = rows.find((x) => x.w === 0)?.cagr;
  for (const x of rows) x.vs = spyCagr === undefined ? null : x.cagr - spyCagr;
  console.log(`\n── ${from.slice(0, 10)} → ${to.slice(0, 10)} (${rS.length} periods) ──`);
  console.log(`satellite   CAGR    vs SPY   max DD  Sharpe  tracking err`);
  for (const x of rows) {
    const vs = spyCagr === undefined ? "" : `${x.cagr - spyCagr >= 0 ? "+" : ""}${(x.cagr - spyCagr).toFixed(2)}`;
    console.log(`${String(x.w).padStart(5)}%   ${x.cagr.toFixed(2).padStart(6)}%  ${vs.padStart(6)}  ${x.dd.toFixed(1).padStart(5)}%  ${x.sharpe.toFixed(2).padStart(6)}  ${x.te.toFixed(1).padStart(8)}%`);
  }
  return rows;
}

console.log(`core-satellite: SPY core + ${dumpPath.split("/").pop()} satellite, rebalanced every clock (0% = SPY only, 100% = strategy only)`);
const full = stats(curve[0].ts, "9999");
const h1 = stats(curve[0].ts, split);
const h2 = stats(split, "9999");

// --write-web: regenerate the table the /agent page shows next to the satellite selector.
const webPath = arg("write-web", null);
if (webPath) {
  const { writeFileSync } = await import("node:fs");
  const label = arg("label", "strategy");
  const r2 = (v) => Math.round(v * 100) / 100;
  const r1 = (v) => Math.round(v * 10) / 10;
  const from = curve[0].ts.slice(0, 4), to = curve.at(-1).ts.slice(0, 4), cut = Number(split.slice(0, 4));
  const rows = full.map((x, i) =>
    `  { satellitePct: ${x.w}, cagr: ${r2(x.cagr)}, vsSpy: ${r2(x.vs)}, cagrFirstHalf: ${r2(h1[i].cagr)}, vsSpyFirstHalf: ${r2(h1[i].vs)}, cagrSecondHalf: ${r2(h2[i].cagr)}, vsSpySecondHalf: ${r2(h2[i].vs)}, maxDrawdown: ${r1(x.dd)}, trackingError: ${r1(x.te)} },`,
  );
  writeFileSync(
    webPath,
    `/**
 * Backtested SPY core + DipBuyer satellite splits, shown next to the satellite selector on the agent page.
 *
 * GENERATED by \`node apps/api/scripts/core-satellite.mjs ${dumpPath.split("/").pop()} --write-web ${webPath} --label "${label}"\`
 * on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand; rerun after a strategy config change. Blend rebalanced every
 * clock; CAGR over actual elapsed time (reads ~0.2 pts above the backtest headline; gaps to SPY unaffected).
 * Past performance is not a guide to future returns.
 */
export interface SplitStats {
  satellitePct: number;
  cagr: number;
  vsSpy: number;
  cagrFirstHalf: number;
  vsSpyFirstHalf: number;
  cagrSecondHalf: number;
  vsSpySecondHalf: number;
  maxDrawdown: number;
  trackingError: number;
}

export const CORE_SATELLITE_SOURCE = "Backtest ${from}-${to}, ${label}, point-in-time S&P 500";
export const CORE_SATELLITE_HALVES = ["${from}-${String(cut - 1).slice(2)}", "${cut}-${to.slice(2)}"] as const;

export const CORE_SATELLITE_SPLITS: SplitStats[] = [
${rows.join("\n")}
];

export const splitFor = (pct: number): SplitStats | undefined => CORE_SATELLITE_SPLITS.find((s) => s.satellitePct === pct);
`,
  );
  console.log(`\nwrote ${webPath}`);
}
