#!/usr/bin/env node
/**
 * Build the insider open-market-purchase index from SEC's quarterly Insider Transactions Data Sets
 * (Forms 3/4/5, https://www.sec.gov/dera/data/form-345).
 *
 *   node apps/api/scripts/build-insider-index.mjs [--from 2015q1] [--to 2025q4] [--dir ~/dipbuyer-data/form345]
 *
 * Output: <dir>/../insider-purchases.json = { "<issuer CIK, 10 digits>": [["YYYY-MM-DD" filing date, usd], ...] }
 * One entry per Form 4 FILING that reports at least one open-market purchase (transaction code P,
 * acquired) of non-derivative stock by an officer or director; usd is the summed shares x price.
 * Keyed by FILING date, not trade date — the filing is when the market could first see it.
 * Sales are deliberately not recorded (Lynch: insider selling is noise; config insider_activity).
 *
 * Needs SEC_EDGAR_USER_AGENT (SEC fair-access policy) and the `unzip` binary. Zips are cached in
 * <dir>, so a rerun only downloads missing quarters. Downloads are sequential with a pause.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
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
const dir = arg("dir", join(homedir(), "dipbuyer-data", "form345"));
const from = arg("from", "2015q1");
const to = arg("to", "2025q4");
const ua = process.env.SEC_EDGAR_USER_AGENT;
if (!ua) throw new Error("SEC_EDGAR_USER_AGENT is not set");
mkdirSync(dir, { recursive: true });

const quarters = [];
for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
  for (let q = 1; q <= 4; q++) {
    const id = `${y}q${q}`;
    if (id >= from && id <= to) quarters.push(id);
  }
}

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const isoDate = (d) => {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${MONTHS[m[2]]}-${m[1]}` : null;
};

/** Parse a TSV into row objects restricted to `cols`. */
function tsv(zip, file, cols) {
  const text = execFileSync("unzip", ["-p", zip, file], { maxBuffer: 1 << 30 }).toString("utf8");
  const lines = text.split("\n");
  const header = lines[0].replace(/\r$/, "").split("\t");
  const idx = cols.map((c) => {
    const i = header.indexOf(c);
    if (i < 0) throw new Error(`${file} in ${zip}: no column ${c}`);
    return i;
  });
  const rows = [];
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, "");
    if (!line) continue;
    const parts = line.split("\t");
    rows.push(Object.fromEntries(cols.map((c, k) => [c, parts[idx[k]] ?? ""])));
  }
  return rows;
}

const index = new Map(); // cik -> Map(accession -> [date, usd])
for (const q of quarters) {
  const zip = join(dir, `${q}_form345.zip`);
  if (!existsSync(zip)) {
    const url = `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${q}_form345.zip`;
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 1000));
  }
  const subs = new Map(
    tsv(zip, "SUBMISSION.tsv", ["ACCESSION_NUMBER", "FILING_DATE", "ISSUERCIK", "DOCUMENT_TYPE"])
      .filter((r) => r.DOCUMENT_TYPE === "4" || r.DOCUMENT_TYPE === "4/A")
      .map((r) => [r.ACCESSION_NUMBER, r]),
  );
  const insiders = new Set(
    tsv(zip, "REPORTINGOWNER.tsv", ["ACCESSION_NUMBER", "RPTOWNER_RELATIONSHIP"])
      .filter((r) => /Director|Officer/i.test(r.RPTOWNER_RELATIONSHIP))
      .map((r) => r.ACCESSION_NUMBER),
  );
  let kept = 0;
  for (const t of tsv(zip, "NONDERIV_TRANS.tsv", ["ACCESSION_NUMBER", "TRANS_CODE", "TRANS_ACQUIRED_DISP_CD", "TRANS_SHARES", "TRANS_PRICEPERSHARE"])) {
    if (t.TRANS_CODE !== "P" || t.TRANS_ACQUIRED_DISP_CD !== "A" || !insiders.has(t.ACCESSION_NUMBER)) continue;
    const sub = subs.get(t.ACCESSION_NUMBER);
    const date = sub && isoDate(sub.FILING_DATE);
    if (!date) continue;
    const usd = (Number(t.TRANS_SHARES) || 0) * (Number(t.TRANS_PRICEPERSHARE) || 0);
    const cik = sub.ISSUERCIK.padStart(10, "0");
    const byAcc = index.get(cik) ?? new Map();
    const prev = byAcc.get(t.ACCESSION_NUMBER);
    byAcc.set(t.ACCESSION_NUMBER, [date, (prev?.[1] ?? 0) + usd]);
    index.set(cik, byAcc);
    kept++;
  }
  console.log(`${q}: ${subs.size} Form 4 filings, ${kept} officer/director open-market purchase rows`);
}

const out = {};
for (const [cik, byAcc] of index) {
  out[cik] = [...byAcc.values()].map(([d, usd]) => [d, Math.round(usd)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const outPath = join(dirname(dir), "insider-purchases.json");
writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath}: ${Object.keys(out).length} issuers, ${Object.values(out).reduce((a, v) => a + v.length, 0)} filings`);
