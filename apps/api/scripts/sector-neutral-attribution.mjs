// Sector-neutral attribution: forward return of each decision minus the mean forward return of all
// screened names in the SAME sector at the SAME clock. Compared with the usual vs-SPY excess.
//   node ~/dipbuyer-runs/sector-neutral-attribution.mjs <dump.json> [criterion]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dumpPath = process.argv[2], CRIT = process.argv[3];
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const cache = JSON.parse(readFileSync(join(dirname(dumpPath), "prices-cache.json"), "utf8"));
const clocks = [...new Set(dump.decisions.map((d) => d.ts))].sort();
const at = new Map(clocks.map((c, i) => [c, i]));
const priceAt = (s, c) => { const b = cache[s]; if (!b) return null; let lo = 0, hi = b.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m][0] <= c) { best = b[m][1]; lo = m + 1; } else hi = m - 1; } return best; };
const fwd = (s, c, H) => { const e = clocks[at.get(c) + H]; if (!e) return null; const a = priceAt(s, c), b = priceAt(s, e); return a && b ? b / a - 1 : null; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function spearman(x, y) { const rk = (v) => { const o = v.map((a, i) => [a, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); o.forEach(([, i], k) => (r[i] = k)); return r; }; const rx = rk(x), ry = rk(y), mx = mean(rx), my = mean(ry); let n = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { n += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return n / Math.sqrt(dx * dy); }
for (const H of [6, 12]) {
  const rows = [];
  const peer = new Map();
  for (const d of dump.decisions) {
    const r = fwd(d.symbol, d.ts, H), m = fwd("SPY", d.ts, H);
    if (r === null || m === null) continue;
    const k = d.ts + "|" + (d.sector ?? "none");
    (peer.get(k) ?? peer.set(k, []).get(k)).push(r);
    rows.push({ d, r, spy: r - m, k });
  }
  for (const x of rows) { const p = peer.get(x.k); x.sec = p.length >= 3 ? x.r - mean(p) : null; }
  console.log(`\n== ${H}-month forward return; sector peers = all screened names in the sector at the clock (min 3) ==`);
  console.log("group".padEnd(14) + "TRAIN vs SPY".padStart(14) + "vs sector".padStart(12) + "n".padStart(7) + "   TEST vs SPY".padStart(15) + "vs sector".padStart(12) + "n".padStart(7));
  const groups = [["buy", (d) => d.verdict === "buy"], ["hold", (d) => d.verdict === "hold"], ["avoid+sell", (d) => d.verdict === "avoid" || d.verdict === "sell"]];
  if (CRIT) {
    groups.push([`${CRIT} pass`, (d) => d.criteria?.some((c) => c[0] === CRIT && c[1] === "pass")]);
    groups.push([`${CRIT} fail`, (d) => d.criteria?.some((c) => c[0] === CRIT && c[1] === "fail")]);
    groups.push([`buy&${CRIT}`, (d) => d.verdict === "buy" && d.criteria?.some((c) => c[0] === CRIT && c[1] === "pass")]);
    groups.push([`buy&!${CRIT}`, (d) => d.verdict === "buy" && d.criteria?.some((c) => c[0] === CRIT && c[1] === "fail")]);
  }
  for (const [g, f] of groups) {
    const line = [g.padEnd(14)];
    for (const half of ["train", "test"]) {
      const s = rows.filter((x) => x.sec !== null && f(x.d) && (x.d.ts < "2021-01-01") === (half === "train"));
      line.push(((100 * mean(s.map((x) => x.spy))).toFixed(2) + "%").padStart(half === "train" ? 14 : 15), ((100 * mean(s.map((x) => x.sec))).toFixed(2) + "%").padStart(12), String(s.length).padStart(7));
    }
    console.log(line.join(""));
  }
  for (const half of ["train", "test"]) {
    const s = rows.filter((x) => x.sec !== null && (x.d.ts < "2021-01-01") === (half === "train"));
    console.log(`Spearman(conviction, return vs sector) ${half}: ${spearman(s.map((x) => x.d.convictionScore), s.map((x) => x.sec)).toFixed(4)}   (vs SPY: ${spearman(s.map((x) => x.d.convictionScore), s.map((x) => x.spy)).toFixed(4)})`);
  }
}
