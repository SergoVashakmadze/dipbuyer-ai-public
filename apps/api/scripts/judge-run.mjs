#!/usr/bin/env node
/**
 * Apply the adoption rule (HANDOVER "Rules for changing the strategy") to a candidate run.
 *
 *   node apps/api/scripts/judge-run.mjs <baseline> <candidate>      (names under ~/dipbuyer-runs, no extension)
 *
 * Reads <name>.log (max drawdown, Sharpe, data-source failures) and <name>-bench.txt (per-half CAGR
 * and alpha vs RSP from benchmark-diagnosis.mjs). Rule: 2016-20 CAGR and alpha vs RSP must improve;
 * 2021-25 must not get worse; max DD not materially worse (+1 pt); Sharpe not below baseline.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.RUNS_DIR || join(homedir(), "dipbuyer-runs");
const [base, cand] = process.argv.slice(2);
if (!base || !cand) throw new Error("usage: judge-run.mjs <baseline> <candidate>");

function load(name) {
  const log = readFileSync(join(dir, `${name}.log`), "utf8");
  const bench = readFileSync(join(dir, `${name}-bench.txt`), "utf8");
  const num = (re) => Number(re.exec(log)?.[1] ?? NaN);
  const out = { dd: num(/^maxDrawdownPct\s+([\d.-]+)/m), sharpe: num(/^sharpe\s+([\d.-]+)/m), failures: /DATA-SOURCE FAILURES|REFUSING TO REPORT/.test(log) };
  let half = null;
  for (const line of bench.split("\n")) {
    if (line.startsWith("── FULL")) half = "full";
    else if (line.startsWith("── FIRST")) half = "h1";
    else if (line.startsWith("── SECOND")) half = "h2";
    const m = /^(STRATEGY|SPY|RSP)\s+([\d.-]+)%(?:\s*\|\s*[\d.-]+\s+([\d.-]+)%)?/.exec(line);
    if (half && m) {
      out[half] ??= {};
      if (m[1] === "STRATEGY") out[half].cagr = Number(m[2]);
      if (m[1] === "SPY") out[half].spy = Number(m[2]);
      if (m[1] === "RSP") out[half].alphaRsp = Number(m[3]);
    }
  }
  return out;
}

const b = load(base), c = load(cand);
const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const d = (x, y) => `${y - x >= 0 ? "+" : ""}${(y - x).toFixed(2)}`;
console.log(`judge: ${cand} vs ${base}\n`);
console.log(`                     baseline  candidate  change`);
for (const [k, label] of [["full", "full"], ["h1", "2016-20"], ["h2", "2021-25"]]) {
  console.log(`${label.padEnd(8)} CAGR       ${f(b[k]?.cagr).padStart(7)}%  ${f(c[k]?.cagr).padStart(8)}%  ${d(b[k]?.cagr, c[k]?.cagr)}   (SPY ${f(c[k]?.spy)}%)`);
  console.log(`${label.padEnd(8)} alpha RSP  ${f(b[k]?.alphaRsp).padStart(7)}   ${f(c[k]?.alphaRsp).padStart(8)}   ${d(b[k]?.alphaRsp, c[k]?.alphaRsp)}`);
}
console.log(`max drawdown         ${f(b.dd).padStart(7)}%  ${f(c.dd).padStart(8)}%  ${d(b.dd, c.dd)}`);
console.log(`Sharpe               ${f(b.sharpe).padStart(7)}   ${f(c.sharpe).padStart(8)}   ${d(b.sharpe, c.sharpe)}\n`);

const checks = [
  ["no data-source failures in either log", !b.failures && !c.failures],
  ["2016-20 CAGR improves", c.h1.cagr > b.h1.cagr],
  ["2016-20 alpha vs RSP improves", c.h1.alphaRsp > b.h1.alphaRsp],
  ["2021-25 CAGR not worse", c.h2.cagr >= b.h2.cagr],
  ["2021-25 alpha vs RSP not worse", c.h2.alphaRsp >= b.h2.alphaRsp],
  ["max drawdown not > +1 pt", c.dd <= b.dd + 1],
  ["Sharpe not below baseline", c.sharpe >= b.sharpe],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const beatsSpy = ["h1", "h2"].every((k) => c[k].cagr > c[k].spy);
console.log(`\nVERDICT: ${checks.every(([, ok]) => ok) ? "ADOPTABLE (owner approval required)" : "REJECT"}${beatsSpy ? " — beats SPY in both halves" : ""}`);
