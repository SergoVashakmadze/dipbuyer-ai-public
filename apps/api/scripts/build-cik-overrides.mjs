/**
 * Builds packages/data/vendor/cik-overrides.json: ticker -> SEC CIK for S&P 500 members that are
 * absent from SEC's CURRENT-STATE company_tickers.json (delisted, acquired, renamed). Without these
 * the point-in-time backtest can price such names but never screen them, so survivorship control
 * is incomplete (144 names in the 2016-2025 run).
 *
 * CIKs come from Polygon/Massive ticker details AS OF the last day the name was in the index, so a
 * recycled ticker resolves to the company that held it then. A CIK is a public SEC identifier.
 *
 *   node apps/api/scripts/build-cik-overrides.mjs [--from 2016-01-01] [--to 2025-12-31]
 *
 * Needs POLYGON_API_KEY and SEC_EDGAR_USER_AGENT (repo-root .env). Free tier = 5 req/min, so this
 * paces itself (~13s per lookup) and resumes from an existing output file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const envPath = fileURLToPath(new URL(".env", root));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const from = arg("from", "2016-01-01");
const to = arg("to", "2025-12-31");
const outPath = fileURLToPath(new URL("packages/data/vendor/cik-overrides.json", root));
const key = process.env.POLYGON_API_KEY;
const ua = process.env.SEC_EDGAR_USER_AGENT;
if (!key || !ua) { console.error("needs POLYGON_API_KEY and SEC_EDGAR_USER_AGENT"); process.exit(1); }

const csv = readFileSync(fileURLToPath(new URL("packages/data/vendor/sp500-membership.csv", root)), "utf8").trim().split(/\r?\n/).slice(1);
const intervals = csv.map((l) => { const [ticker, start, end] = l.split(","); return { ticker, start, end: end || null }; })
  .filter((r) => r.start <= to && (r.end === null || r.end > from));

const sec = await (await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": ua } })).json();
const current = new Set(Object.values(sec).map((r) => String(r.ticker).toUpperCase()));

// Last in-index day per ticker (latest interval), clamped to the window.
const lastDay = new Map();
for (const r of intervals) {
  const end = r.end ? new Date(Date.parse(r.end) - 86_400_000).toISOString().slice(0, 10) : to;
  const d = end > to ? to : end;
  if (!lastDay.has(r.ticker) || d > lastDay.get(r.ticker)) lastDay.set(r.ticker, d);
}
const missing = [...lastDay.keys()].filter((t) => !current.has(t.toUpperCase()) && !current.has(t.replace(".", "-"))).sort();
console.log(`${intervals.length} intervals, ${lastDay.size} tickers in window, ${missing.length} absent from SEC's current map`);

const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { generated: null, source: "polygon ticker details (date = last day in S&P 500)", overrides: {}, unresolved: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const t of missing) {
  if (out.overrides[t] || out.unresolved[t]) continue;
  const date = lastDay.get(t);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(t)}?date=${date}`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 429) { await sleep(65_000); continue; }
    const body = await res.json().catch(() => ({}));
    const cik = body?.results?.cik;
    if (res.ok && cik) out.overrides[t] = { cik: String(Number(cik)), name: body.results.name ?? null, asOf: date };
    else out.unresolved[t] = { asOf: date, status: res.status, reason: body?.results ? "no cik in ticker details" : (body?.message ?? body?.status ?? "not found") };
    console.log(`${t.padEnd(6)} ${date} -> ${out.overrides[t] ? `CIK ${out.overrides[t].cik} ${out.overrides[t].name}` : `unresolved (${out.unresolved[t].reason})`}`);
    break;
  }
  out.generated = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  await sleep(13_000);
}
console.log(`done: ${Object.keys(out.overrides).length} resolved, ${Object.keys(out.unresolved).length} unresolved -> ${outPath}`);
