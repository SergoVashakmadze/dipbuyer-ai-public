/**
 * Threshold calibration evidence — cross-sectional distribution of Lynch metrics across the
 * universe, plus which criteria actually reject names.
 *
 *   node apps/api/scripts/calibrate.mjs [--asOf 2026-07-19]
 *
 * METHOD (deliberate, and the reason this is not curve-fitting):
 * Thresholds are calibrated against the DISTRIBUTION of the current market, never against
 * backtest returns. Tuning cutoffs until a backtest improves fits noise, produces a number that
 * will not generalise, and cannot be defended to an investor or a regulator. What this script
 * answers instead is: "Lynch wanted 'conservatively financed' — what D/E is that TODAY?" The
 * answer is a percentile of real peers, which preserves his intent as the market changes.
 *
 * Output feeds config/strategy.lynch.json. Values tagged `impl_default` there are our own
 * encoding choices and are freely calibratable; `lynch_book` values are Lynch's own numbers and
 * changing one must be deliberate and documented.
 */
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
process.env.FINANCIALDATASETS_API_KEY = ""; // force the free EDGAR path

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const asOf = arg("asOf", new Date().toISOString().slice(0, 10));

const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "INTC", "CSCO", "ORCL", "CRM", "ADBE", "AMD", "MU", "TXN",
  "JNJ", "PFE", "MRK", "UNH", "ABBV", "CVS",
  "JPM", "BAC", "WFC", "GS", "AXP",
  "KO", "PEP", "PG", "WMT", "MCD", "NKE", "SBUX", "TGT", "WBA",
  "CAT", "BA", "GE", "HON", "UPS",
  "XOM", "CVX", "VZ", "T", "HD", "LOW", "DIS",
];

const { buildDecisionService } = await import(
  new URL("../dist/decision/decision.providers.js", import.meta.url).href
);
const { InMemoryDecisionStore } = await import("@dipbuyer/agent");

const svc = buildDecisionService(new InMemoryDecisionStore());

const verdicts = {};
const failCount = {};
const evalCount = {};
const values = {}; // criterion -> numeric values seen
const rows = [];
let errors = 0;

for (const symbol of UNIVERSE) {
  try {
    const { record } = await svc.analyze(symbol, { mode: "RESEARCH_ONLY", execution: "PAPER", asOf });
    verdicts[record.verdict] = (verdicts[record.verdict] ?? 0) + 1;
    rows.push({ symbol, verdict: record.verdict, category: record.lynchCategory, score: record.convictionScore });
    for (const c of record.criteria) {
      evalCount[c.name] = (evalCount[c.name] ?? 0) + 1;
      if (c.result !== "pass") failCount[c.name] = (failCount[c.name] ?? 0) + 1;
      if (typeof c.value === "number" && Number.isFinite(c.value)) {
        (values[c.name] ??= []).push(c.value);
      }
    }
  } catch (e) {
    errors++;
    process.stderr.write(`  ! ${symbol}: ${e.message}\n`);
  }
}

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
};
const fmt = (v) => (v === null ? "—" : v.toFixed(2));

console.log(`\nasOf ${asOf} · ${rows.length}/${UNIVERSE.length} analysed (${errors} errors)\n`);

console.log("VERDICTS");
for (const [v, n] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(10)} ${String(n).padStart(3)}  ${((n / rows.length) * 100).toFixed(0)}%`);
}

console.log("\nCRITERION REJECTION RATE  (how often each gate blocks a name)");
for (const [k, n] of Object.entries(failCount).sort((a, b) => b[1] / evalCount[b[0]] - a[1] / evalCount[a[0]])) {
  const bar = "█".repeat(Math.round((n / evalCount[k]) * 20));
  console.log(`  ${k.padEnd(24)} ${String(n).padStart(2)}/${String(evalCount[k]).padEnd(2)} ${((n / evalCount[k]) * 100).toFixed(0).padStart(3)}%  ${bar}`);
}

console.log("\nCROSS-SECTIONAL DISTRIBUTION  (calibration evidence — where should a cutoff sit?)");
console.log(`  ${"criterion".padEnd(24)} ${"p10".padStart(8)} ${"p25".padStart(8)} ${"median".padStart(8)} ${"p75".padStart(8)} ${"p90".padStart(8)}`);
for (const [k, vs] of Object.entries(values)) {
  const s = [...vs].sort((a, b) => a - b);
  console.log(
    `  ${k.padEnd(24)} ${fmt(pct(s, 10)).padStart(8)} ${fmt(pct(s, 25)).padStart(8)} ${fmt(pct(s, 50)).padStart(8)} ${fmt(pct(s, 75)).padStart(8)} ${fmt(pct(s, 90)).padStart(8)}`,
  );
}

console.log("\nPER-NAME");
for (const r of rows.sort((a, b) => b.score - a.score)) {
  console.log(`  ${r.symbol.padEnd(6)} ${String(r.score).padStart(3)}  ${String(r.verdict).padEnd(8)} ${r.category ?? "—"}`);
}
console.log(
  "\nNOTE: calibrate against THIS distribution, not against backtest returns. Re-run and compare\n" +
    "before/after rejection rates; validate any change on an out-of-sample window.",
);
