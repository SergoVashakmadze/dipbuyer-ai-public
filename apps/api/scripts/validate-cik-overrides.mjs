/**
 * Second pass over packages/data/vendor/cik-overrides.json (run after build-cik-overrides.mjs).
 *
 * 1. VALIDATES every mapping against SEC itself: the CIK must have filed a 10-K for a fiscal year
 *    ending within ~2 years before the ticker's last day in the index, filed before that day.
 *    This rejects a ticker that resolved to a LATER company reusing it (ARNC in April 2020 is the
 *    old Arconic, CIK 4281 — not the spun-off Arconic Corp, CIK 1790982, whose first 10-K came in
 *    2021).
 * 2. RESOLVES the rest by name: Alpaca still returns names for inactive assets; SEC's EDGAR
 *    company search maps a name to candidate CIKs; exactly one candidate must pass the same check.
 *
 * Paced at ~1 request/second so it can run beside a backtest without breaching SEC's 10 req/s.
 * Needs SEC_EDGAR_USER_AGENT and ALPACA_KEY_ID / ALPACA_SECRET_KEY (repo-root .env).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const envPath = fileURLToPath(new URL(".env", root));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const outPath = fileURLToPath(new URL("packages/data/vendor/cik-overrides.json", root));
const ua = process.env.SEC_EDGAR_USER_AGENT;
const data = JSON.parse(readFileSync(outPath, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sec(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" } });
    await sleep(1100);
    if (res.status === 403 || res.status === 429 || res.status >= 500) { await sleep(10_000 * (i + 1)); continue; }
    return res.ok ? res.json() : null;
  }
  return null;
}

/** True when the CIK filed an annual report consistent with being this index member at asOf. */
async function filedAnnualBefore(cik, asOf) {
  const facts = await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`);
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return { ok: false, why: "no us-gaap facts" };
  const lo = new Date(Date.parse(asOf) - 2.2 * 365 * 86_400_000).toISOString().slice(0, 10);
  for (const concept of ["NetIncomeLoss", "ProfitLoss", "Revenues", "EarningsPerShareDiluted", "Assets"]) {
    for (const f of Object.values(gaap[concept]?.units ?? {}).flat()) {
      if ((f.form === "10-K" || f.form === "10-K/A") && f.filed <= asOf && f.end >= lo && f.end <= asOf) {
        return { ok: true, why: `${concept} ${f.end} filed ${f.filed}`, entity: facts.entityName };
      }
    }
  }
  return { ok: false, why: `no 10-K for a period ending ${lo}..${asOf} filed by ${asOf}`, entity: facts.entityName };
}

const validated = {};
const rejected = {};
for (const [t, v] of Object.entries(data.overrides)) {
  const r = await filedAnnualBefore(v.cik, v.asOf);
  if (r.ok) validated[t] = { ...v, secEntity: r.entity, evidence: r.why, via: "polygon" };
  else rejected[t] = { ...v, reason: r.why };
  console.log(`${t.padEnd(6)} polygon CIK ${v.cik} ${r.ok ? "OK " + r.why : "REJECT " + r.why}`);
}

const retry = { ...data.unresolved, ...rejected };
const unresolved = {};
for (const [t, v] of Object.entries(retry)) {
  const a = await (await fetch(`https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(t)}`, {
    headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY },
  })).json().catch(() => ({}));
  const name = (a.name ?? v.name ?? "").replace(/\b(Common Stock|Class [A-C]|Ordinary Shares|American Depositary Shares.*)\b/gi, "").replace(/[.,]/g, " ").trim();
  if (!name) { unresolved[t] = { ...v, reason: "no name to search" }; console.log(`${t.padEnd(6)} unresolved (no name)`); continue; }
  const words = name.split(/\s+/).filter((w) => !/^(inc|corp|corporation|co|company|plc|ltd|holdings?|group|the|&)$/i.test(w)).slice(0, 3).join(" ");
  const search = await sec(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(words)}`);
  const candidates = (search?.hits?.hits ?? []).map((h) => ({ cik: String(Number(h._id)), entity: h._source?.entity ?? "" })).slice(0, 6);
  const passing = [];
  for (const c of candidates) {
    const r = await filedAnnualBefore(c.cik, v.asOf);
    if (r.ok) passing.push({ ...c, why: r.why, secEntity: r.entity });
  }
  if (passing.length === 1) {
    validated[t] = { cik: passing[0].cik, name, asOf: v.asOf, secEntity: passing[0].secEntity, evidence: passing[0].why, via: "name-search" };
    console.log(`${t.padEnd(6)} name "${words}" -> CIK ${passing[0].cik} ${passing[0].secEntity}`);
  } else {
    unresolved[t] = { asOf: v.asOf, name, reason: passing.length ? `ambiguous: ${passing.map((p) => `${p.cik} ${p.secEntity}`).join("; ")}` : `no candidate filed a 10-K before ${v.asOf}` };
    console.log(`${t.padEnd(6)} unresolved (${unresolved[t].reason})`);
  }
}

data.overrides = validated;
data.unresolved = unresolved;
data.validated = new Date().toISOString();
data.validation = "each CIK filed a 10-K for a period ending within ~2.2 years before the ticker's last day in the index, filed by that day";
writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
console.log(`validated ${Object.keys(validated).length}, unresolved ${Object.keys(unresolved).length}`);
