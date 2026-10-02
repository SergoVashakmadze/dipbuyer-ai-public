/**
 * Repeatable wide-universe backtest against REAL data (SEC EDGAR fundamentals + Alpaca prices).
 *
 * Price source: Alpaca by default. `BACKTEST_PRICE_SOURCE=polygon` (+ POLYGON_API_KEY) reruns the
 * same backtest on Polygon/Massive history; `dataSource` in the output records which was used.
 *
 *   node apps/api/scripts/run-backtest.mjs [--from 2023-01-01] [--to 2025-12-31] [--rebalance monthly]
 *                                         [--point-in-time]
 *
 * ⚠️ SURVIVORSHIP BIAS — the single biggest caveat on any number this produces.
 * WITHOUT `--point-in-time` the universe below is a hand-picked list of companies that EXIST
 * TODAY. Firms delisted, acquired or bankrupted over the window are absent, so the sample is
 * tilted toward survivors and results are optimistic. Mitigated only partially by deliberately
 * including names that performed BADLY (INTC, CVS, PFE, BA, NKE, WBA, TGT) rather than a
 * winners-only list.
 *
 * `--point-in-time` is the real fix: it screens actual S&P 500 membership as of each rebalance
 * date, so SIVB, FRC, TWTR and ATVI are all in the investable set on the dates they really were.
 * EXPECT WORSE NUMBERS — that is the bias being removed, not a regression. It is also MUCH slower
 * (~500 names per clock instead of 46; price calls dominate), so budget hours, not minutes.
 *
 * Other limits: US filers only (EDGAR); ~45 names is still a small sample; one window is one
 * regime, not evidence a strategy generalises.
 */
// fileURLToPath, NOT url.pathname — the repo path contains spaces and pathname leaves them
// percent-encoded ("D%20Drive"), which fails to open.
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

/** Sector-diverse US large/mid caps, INCLUDING deliberate underperformers (see bias note). */
export const UNIVERSE = [
  // Tech / semis
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "INTC", "CSCO", "ORCL", "CRM", "ADBE", "AMD", "MU", "TXN",
  // Healthcare
  "JNJ", "PFE", "MRK", "UNH", "ABBV", "CVS",
  // Financials
  "JPM", "BAC", "WFC", "GS", "AXP",
  // Consumer
  "KO", "PEP", "PG", "WMT", "MCD", "NKE", "SBUX", "TGT", "WBA",
  // Industrials
  "CAT", "BA", "GE", "HON", "UPS",
  // Energy / telecom / retail
  "XOM", "CVX", "VZ", "T", "HD", "LOW", "DIS",
];

const { BacktestService } = await import(new URL("../dist/backtest/backtest.service.js", import.meta.url).href);

const from = `${arg("from", "2023-01-01")}T00:00:00Z`;
const to = `${arg("to", "2025-12-31")}T00:00:00Z`;
const rebalance = arg("rebalance", "monthly");
const pointInTime = process.argv.includes("--point-in-time");

console.log(`universe   ${pointInTime ? "S&P 500 point-in-time membership" : `${UNIVERSE.length} names (static, survivors only)`}`);
console.log(`window     ${from.slice(0, 10)} -> ${to.slice(0, 10)} (${rebalance})`);
console.log("running…\n");

const t0 = Date.now();
const dumpPath = arg("dump", null);
const out = await new BacktestService().run({
  universe: UNIVERSE,
  from,
  to,
  rebalance,
  pointInTimeUniverse: pointInTime,
  includeDecisionSummaries: Boolean(dumpPath),
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const n = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : String(v));
// A missing key (e.g. an editor saving over .env mid-session) silently switches the whole run to
// synthetic fixtures, which then report fantasy metrics (41.86% CAGR, Sharpe 35) in the same
// format as a real run. --require-real-data turns that into a hard failure.
if (process.argv.includes("--require-real-data") && out.dataSource?.synthetic) {
  console.error(`REFUSING TO REPORT: run used synthetic data ${JSON.stringify(out.dataSource)}. Check ALPACA_* and SEC_EDGAR_USER_AGENT in .env.`);
  process.exit(2);
}
// Transient fetch failures drop names from individual rebalances and yield plausible but wrong
// metrics (exp-signals: 23 symbol-clocks lost, CAGR 13.06% vs 13.46%). Warning was not enough.
if (process.argv.includes("--require-real-data") && out.dataSourceFailures > 0) {
  console.error(`REFUSING TO REPORT: ${out.dataSourceFailures} symbol-clock(s) skipped on DATA-SOURCE FAILURES (see warning above). Rerun; the caches make a retry cheap.`);
  process.exit(3);
}
console.log(`dataSource         ${JSON.stringify(out.dataSource)}`);
console.log(`exactFilingDates   ${out.exactFilingDates}`);
console.log(`universeSource     ${out.universeSource} (${out.params.universe.length} names reachable)`);
console.log(`decisions          ${out.decisions}`);
console.log(`equity points      ${out.equityCurve.length}`);
console.log(`─────────────────────────────`);
console.log(`totalReturnPct     ${n(out.metrics.totalReturnPct)}`);
console.log(`cagrPct            ${n(out.metrics.cagrPct)}`);
console.log(
  `benchmarkRelative  ${
    out.metrics.benchmarkRelativePct === null
      ? "n/a — benchmark could not be priced (see warning above); NOT a 0% benchmark"
      : `${n(out.metrics.benchmarkRelativePct)} pts vs ${out.params.benchmark}`
  }`,
);
console.log(`maxDrawdownPct     ${n(out.metrics.maxDrawdownPct)}`);
console.log(`sharpe             ${n(out.metrics.sharpe, 3)}`);
console.log(`sortino            ${n(out.metrics.sortino, 3)}`);
console.log(`calmar             ${n(out.metrics.calmar, 3)}`);
console.log(`winRatePct         ${n(out.metrics.winRatePct)}`);
console.log(`avgCashPct         ${n(out.metrics.avgCashPct)}  (idle cash; a drag vs a fully-invested benchmark)`);
console.log(`cashPolicy         ${out.params.cashPolicy ?? "none"}`);
if (out.metrics.avgSleevePct !== undefined) console.log(`avgSleevePct       ${n(out.metrics.avgSleevePct)}  (cash parked in ${out.params.benchmark})`);
if (out.metrics.cashInterestPct !== undefined) console.log(`cashInterestPct    ${n(out.metrics.cashInterestPct)}  (T-bill interest earned, % of initial capital)`);
console.log(`strategyConfig     ${process.env.STRATEGY_CONFIG_PATH || "config/strategy.lynch.json"}`);
console.log(`dipEntry           ${out.params.dipEntry ? JSON.stringify(out.params.dipEntry) : "off"}`);
console.log(`sellPolicy         ${out.params.sellPolicy ?? "any-avoid"}`);
console.log(`sizing             ${out.params.sizing ?? "equal"}`);
console.log(`profitTake         ${out.params.profitTake ? JSON.stringify(out.params.profitTake) : "off"}`);
console.log(`cikOverrides       ${["0", "false", "no", "off"].includes((process.env.BACKTEST_CIK_OVERRIDES ?? "").toLowerCase()) ? "off" : "on"}`);
console.log(`─────────────────────────────`);
console.log(`elapsed            ${secs}s`);
if (dumpPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dumpPath, JSON.stringify({ params: out.params, metrics: out.metrics, sectorCoverage: out.sectorCoverage, equityCurve: out.equityCurve, decisions: out.decisionSummaries }, null, 0));
  console.log(`decisions dumped   ${dumpPath} (${out.decisionSummaries?.length ?? 0} records)`);
}
console.log(
  pointInTime
    ? `\n✅ Survivorship-controlled: screened real S&P 500 membership per rebalance date, delisted names included.`
    : `\n⚠️  Survivorship-biased universe (survivors only) — see header. Treat as indicative, not evidence.\n   Re-run with --point-in-time for a defensible number.`,
);
