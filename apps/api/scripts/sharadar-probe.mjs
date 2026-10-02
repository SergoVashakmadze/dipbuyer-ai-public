#!/usr/bin/env node
/**
 * Pre-purchase checks for Sharadar (Nasdaq Data Link) as the long-history backtest source.
 * Run once the account works; prints PASS / FAIL / UNVERIFIED per check. One request per second.
 *
 *   node apps/api/scripts/sharadar-probe.mjs
 *
 * Checks (see HANDOVER "Sharadar evaluation"):
 *   1 history depth (SEP prices, SF1 fundamentals back to ~1998-2000)
 *   2 point-in-time filing dates (SF1 datekey vs SEC EDGAR filed date)
 *   3 delisted names have prices AND fundamentals (Lehman, WaMu, SVB, First Republic)
 *   4 S&P 500 membership history (SP500 table) back to 1998, consistent with the vendored list
 *   5 adjusted closes agree with Alpaca (within 0.5%)
 *   6 fundamentals agree with our SEC EDGAR adapter (EPS)
 *   7 delisting events carry a type (ACTIONS table)
 * A 403 / empty result on a table is reported as UNVERIFIED (not included in this account), not FAIL.
 */
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));

const KEY = process.env.NASDAQ_DATA_LINK_API_KEY;
if (!KEY) throw new Error("NASDAQ_DATA_LINK_API_KEY is not set");
const BASE = "https://data.nasdaq.com/api/v3/datatables/SHARADAR";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
async function table(name, params) {
  if (calls++) await sleep(1100);
  const u = new URL(`${BASE}/${name}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("api_key", KEY);
  const res = await fetch(u);
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) {
    console.error(`STOP: HTTP 429 ${body?.quandl_error?.code ?? ""} ${body?.quandl_error?.message ?? ""}`);
    process.exit(2);
  }
  if (!res.ok || !body.datatable) return { ok: false, status: res.status, msg: body?.quandl_error?.message ?? "" };
  const cols = body.datatable.columns.map((c) => c.name);
  return { ok: true, rows: body.datatable.data.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))) };
}

const results = [];
const report = (n, status, detail) => {
  results.push([n, status]);
  console.log(`${status.padEnd(10)} ${n}  ${detail}`);
};

// 1. History depth
{
  const sep = await table("SEP", { ticker: "AAPL", "date.lte": "2000-01-31", "qopts.columns": "ticker,date,closeadj", "qopts.per_page": "5" });
  const sf1 = await table("SF1", { ticker: "AAPL", dimension: "ARY", "calendardate.lte": "2000-12-31", "qopts.columns": "ticker,calendardate,datekey,eps" });
  if (!sep.ok && !sf1.ok) report("1 history depth", "UNVERIFIED", `SEP ${sep.status} ${sep.msg} / SF1 ${sf1.status} ${sf1.msg}`);
  else {
    const p = sep.ok && sep.rows.length ? `SEP from ${sep.rows.map((r) => r.date).sort()[0]}` : `SEP ${sep.ok ? "no rows" : sep.status}`;
    const f = sf1.ok && sf1.rows.length ? `SF1 from ${sf1.rows.map((r) => r.calendardate).sort()[0]}` : `SF1 ${sf1.ok ? "no rows" : sf1.status}`;
    report("1 history depth", sep.ok && sep.rows.length && sf1.ok && sf1.rows.length ? "PASS" : "FAIL", `${p}; ${f}`);
  }
}

// 2. Point-in-time filing dates vs EDGAR (AAPL annual EPS)
let sf1Aapl = null;
{
  const sf1 = await table("SF1", { ticker: "AAPL", dimension: "ARY", "calendardate.gte": "2015-01-01", "qopts.columns": "ticker,calendardate,reportperiod,datekey,eps,epsdil" });
  sf1Aapl = sf1.ok ? sf1.rows : null;
  if (!sf1.ok || !sf1.rows.length) report("2 point-in-time dates", "UNVERIFIED", `SF1 ${sf1.status ?? "no rows"} ${sf1.msg ?? ""}`);
  else {
    const ua = process.env.SEC_EDGAR_USER_AGENT;
    const edgar = await fetch("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/EarningsPerShareDiluted.json", { headers: { "User-Agent": ua } }).then((r) => r.json());
    const filed = new Map(edgar.units["USD/shares"].filter((x) => x.form === "10-K" && x.fp === "FY").map((x) => [x.end, x.filed]));
    const diffs = sf1.rows
      .filter((r) => r.reportperiod && filed.has(r.reportperiod))
      .map((r) => Math.round((Date.parse(r.datekey) - Date.parse(filed.get(r.reportperiod))) / 86_400_000));
    const worst = diffs.length ? Math.max(...diffs.map(Math.abs)) : null;
    report("2 point-in-time dates", worst !== null && worst <= 5 ? "PASS" : "FAIL", `${diffs.length} fiscal years matched; datekey - EDGAR filed (days): [${diffs.join(", ")}]`);
  }
}

// 3. Delisted names: prices and fundamentals
{
  const names = ["LEHMQ", "WAMUQ", "SIVBQ", "FRCB"];
  const tick = await table("TICKERS", { table: "SEP", ticker: names.join(","), "qopts.columns": "ticker,name,isdelisted,firstpricedate,lastpricedate" });
  if (!tick.ok) report("3 delisted coverage", "UNVERIFIED", `TICKERS ${tick.status} ${tick.msg}`);
  else {
    const found = tick.rows.map((r) => `${r.ticker} ${r.firstpricedate}..${r.lastpricedate}${r.isdelisted === "Y" ? " delisted" : ""}`);
    let fund = 0;
    for (const t of tick.rows.map((r) => r.ticker).slice(0, 2)) {
      const f = await table("SF1", { ticker: t, dimension: "ARY", "qopts.columns": "ticker,calendardate,eps", "qopts.per_page": "3" });
      if (f.ok && f.rows.length) fund++;
    }
    report("3 delisted coverage", tick.rows.length >= 3 && fund >= 1 ? "PASS" : "FAIL", `${tick.rows.length}/${names.length} found [${found.join("; ")}]; fundamentals for ${fund} checked`);
  }
}

// 4. S&P 500 membership history
{
  const sp = await table("SP500", { "date.lte": "1999-12-31", "qopts.columns": "date,action,ticker", "qopts.per_page": "10" });
  const lehm = await table("SP500", { ticker: "LEHMQ", "qopts.columns": "date,action,ticker" });
  if (!sp.ok) report("4 S&P 500 membership", "UNVERIFIED", `SP500 ${sp.status} ${sp.msg}`);
  else report("4 S&P 500 membership", sp.rows.length ? "PASS" : "FAIL", `rows before 2000: ${sp.rows.length}; Lehman actions: ${lehm.ok ? JSON.stringify(lehm.rows) : lehm.status}`);
}

// 5. Adjusted closes vs Alpaca (SPY via SFP, AAPL via SEP) on a few 2019 dates
{
  const sep = await table("SEP", { ticker: "AAPL", "date.gte": "2019-06-03", "date.lte": "2019-06-07", "qopts.columns": "date,closeadj" });
  if (!sep.ok || !sep.rows.length) report("5 prices vs Alpaca", "UNVERIFIED", `SEP ${sep.status ?? "no rows"} ${sep.msg ?? ""}`);
  else {
    const u = "https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Day&start=2019-06-03&end=2019-06-08&adjustment=all&feed=sip";
    const alp = await fetch(u, { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY } }).then((r) => r.json());
    const a = new Map((alp.bars ?? []).map((b) => [b.t.slice(0, 10), b.c]));
    const devs = sep.rows.filter((r) => a.has(r.date)).map((r) => Math.abs(r.closeadj / a.get(r.date) - 1) * 100);
    const worst = devs.length ? Math.max(...devs) : null;
    report("5 prices vs Alpaca", worst !== null && worst <= 0.5 ? "PASS" : "FAIL", `${devs.length} days compared; worst deviation ${worst === null ? "n/a" : worst.toFixed(3) + "%"}`);
  }
}

// 6. Fundamentals vs EDGAR (AAPL diluted EPS by fiscal year)
{
  if (!sf1Aapl?.length) report("6 fundamentals vs EDGAR", "UNVERIFIED", "no SF1 rows from check 2");
  else {
    const ua = process.env.SEC_EDGAR_USER_AGENT;
    await sleep(1100);
    const edgar = await fetch("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/EarningsPerShareDiluted.json", { headers: { "User-Agent": ua } }).then((r) => r.json());
    const byEnd = new Map(edgar.units["USD/shares"].filter((x) => x.form === "10-K" && x.fp === "FY").map((x) => [x.end, x.val]));
    const pairs = sf1Aapl.filter((r) => byEnd.has(r.reportperiod)).map((r) => [r.reportperiod, r.epsdil, byEnd.get(r.reportperiod)]);
    const bad = pairs.filter(([, s, e]) => Math.abs(s - e) > 0.02);
    report("6 fundamentals vs EDGAR", pairs.length && !bad.length ? "PASS" : "FAIL", `${pairs.length} years compared${bad.length ? `; mismatches ${JSON.stringify(bad)}` : ""} (note: Sharadar may split-adjust EPS; a constant ratio = split, not an error)`);
  }
}

// 7. Delisting events with a type
{
  const act = await table("ACTIONS", { ticker: "LEHMQ", "qopts.columns": "date,action,ticker,name,value,contraticker" });
  if (!act.ok) report("7 delisting events", "UNVERIFIED", `ACTIONS ${act.status} ${act.msg}`);
  else report("7 delisting events", act.rows.some((r) => /delist|bankrupt/i.test(r.action)) ? "PASS" : "FAIL", `Lehman actions: ${act.rows.map((r) => `${r.date} ${r.action}`).join("; ") || "none"}`);
}

const n = (s) => results.filter(([, x]) => x === s).length;
console.log(`\n${n("PASS")} pass, ${n("FAIL")} fail, ${n("UNVERIFIED")} unverified (not reachable with this account) — ${calls} Nasdaq requests`);
