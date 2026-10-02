#!/usr/bin/env node
/**
 * Recent insider purchases for S&P 500 companies, from SEC EDGAR's DAILY Form 4 filings.
 *
 * The quarterly Form 3/4/5 data sets (build-insider-index.mjs) lag by a quarter or more, so they are
 * right for backtests but not for "who is buying now". This reads each day's EDGAR form index,
 * keeps Form 4 filings whose ISSUER is a current S&P 500 member, fetches the filing, and records every
 * open-market purchase (transaction code P, acquired) by an officer or director.
 *
 *   node apps/api/scripts/build-insider-recent.mjs [--days 120] [--out ~/dipbuyer-data/insider-recent.json] [--reparse]
 *
 * Output: JSON array, newest first: { accession, cik, ticker, company, filed, tradeDate, insider, title,
 * isDirector, isOfficer, shares, price, usd }. Filings are cached in <out dir>/form4-cache, so a daily
 * rerun only fetches that day's new filings. Rate-limited to ~8 requests/second (SEC fair access);
 * needs SEC_EDGAR_USER_AGENT.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// .env is a local-development convenience; on the server (Railway) settings come from the environment.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
try {
  process.loadEnvFile(envFile);
} catch {
  /* no .env: use the process environment */
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const days = Number(arg("days", "120"));
const out = arg("out", join(homedir(), "dipbuyer-data", "insider-recent.json"));
const cacheDir = join(dirname(out), "form4-cache");
mkdirSync(cacheDir, { recursive: true });
const ua = process.env.SEC_EDGAR_USER_AGENT;
if (!ua) throw new Error("SEC_EDGAR_USER_AGENT is not set");

let last = 0;
async function get(url, { missingOk = false } = {}) {
  const wait = last + 125 - Date.now(); // <= 8 requests per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    // EDGAR answers a daily index that is not published yet (today, holidays) with 403, not 404.
    if (res.status === 404 || (missingOk && res.status === 403)) return null;
    if (res.ok) return res.text();
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`${url}: failed after retries`);
}

// Current S&P 500 members -> CIK (dotted class shares use SEC's dashed form).
const csv = readFileSync(fileURLToPath(new URL("../../../packages/data/vendor/sp500-membership.csv", import.meta.url)), "utf8");
const current = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((c) => !c[2]).map((c) => c[0].toUpperCase());
const tickerMap = JSON.parse(await get("https://www.sec.gov/files/company_tickers.json"));
const cikOfTicker = new Map(Object.values(tickerMap).map((e) => [e.ticker.toUpperCase(), String(e.cik_str)]));
const members = new Map(); // cik (unpadded) -> ticker
for (const t of current) {
  const cik = cikOfTicker.get(t) ?? cikOfTicker.get(t.replace(/\./g, "-"));
  if (cik) members.set(cik, t);
}
console.log(`${members.size} of ${current.length} current S&P 500 members resolved to a CIK`);

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
// A field is either <name>text</name> or <name><value>text</value><footnoteId .../></name>; the footnote
// marker after </value> (common on prices) broke an earlier one-regex parse and read the price as 0.
const tag = (xml, name) => {
  const block = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
  if (block === undefined) return "";
  const value = /<value>([\s\S]*?)<\/value>/.exec(block);
  return decode((value ? value[1] : block.replace(/<[^>]+>/g, "")).trim());
};

function parseForm4(text, accession, cik, filed) {
  const xml = /<XML>([\s\S]*?)<\/XML>/i.exec(text)?.[1] ?? "";
  if (!xml.includes("<ownershipDocument")) return [];
  if (tag(xml, "issuerCik").replace(/^0+/, "") !== cik) return []; // the owner's copy of someone else's filing
  const owner = /<reportingOwner>([\s\S]*?)<\/reportingOwner>/.exec(xml)?.[1] ?? "";
  const isDirector = /^(1|true)$/i.test(tag(owner, "isDirector"));
  const isOfficer = /^(1|true)$/i.test(tag(owner, "isOfficer"));
  if (!isDirector && !isOfficer) return [];
  const insider = tag(owner, "rptOwnerName");
  const title = tag(owner, "officerTitle") || (isDirector ? "Director" : "Officer");
  const rows = [];
  for (const [, t] of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    if (tag(t, "transactionCode") !== "P" || tag(t, "transactionAcquiredDisposedCode") !== "A") continue;
    const shares = Number(tag(t, "transactionShares")) || 0;
    const price = Number(tag(t, "transactionPricePerShare")) || 0;
    rows.push({
      accession,
      cik,
      ticker: members.get(cik),
      company: tag(xml, "issuerName"),
      filed,
      tradeDate: tag(t, "transactionDate").slice(0, 10),
      insider,
      title,
      isDirector,
      isOfficer,
      shares,
      price,
      usd: Math.round(shares * price),
    });
  }
  return rows;
}

// --reparse: ignore the previous output and re-read every cached filing (after a parser fix).
const reparse = process.argv.includes("--reparse");
const previous = !reparse && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
const byAccession = new Map();
for (const r of previous) (byAccession.get(r.accession) ?? byAccession.set(r.accession, []).get(r.accession)).push(r);
const cutoff = new Date(Date.now() - days * 86_400_000);
let filings = 0, fetched = 0;
for (let d = new Date(); d >= cutoff; d = new Date(d.getTime() - 86_400_000)) {
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const qtr = Math.floor(d.getUTCMonth() / 3) + 1;
  const idx = await get(`https://www.sec.gov/Archives/edgar/daily-index/${d.getUTCFullYear()}/QTR${qtr}/form.${ymd}.idx`, { missingOk: true });
  if (!idx) continue; // holiday or not published yet
  const filed = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
  for (const line of idx.split("\n")) {
    const m = /^4\s+.+?\s{2,}(\d+)\s+\d{8}\s+(edgar\/data\/\S+\.txt)/.exec(line);
    if (!m || !members.has(m[1])) continue;
    const accession = m[2].split("/").pop().replace(".txt", "");
    if (byAccession.has(accession)) continue;
    filings++;
    const cachePath = join(cacheDir, `${accession}.txt`);
    let text = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
    if (text === null) {
      const full = (await get(`https://www.sec.gov/Archives/${m[2]}`)) ?? "";
      // Keep only the ownership XML: the full submission is several times larger.
      text = `<XML>${/<XML>([\s\S]*?)<\/XML>/i.exec(full)?.[1] ?? ""}</XML>`;
      writeFileSync(cachePath, text);
      fetched++;
    }
    byAccession.set(accession, parseForm4(text, accession, m[1], filed));
  }
  process.stdout.write(`\r${filed}: ${filings} new S&P 500 Form 4 filings, ${fetched} fetched`);
}

const rows = [...byAccession.values()].flat().filter((r) => new Date(r.filed) >= cutoff);
rows.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : b.usd - a.usd));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows));
console.log(`\nwrote ${out}: ${rows.length} officer/director open-market purchases, ${new Set(rows.map((r) => r.ticker)).size} companies, since ${cutoff.toISOString().slice(0, 10)}`);
