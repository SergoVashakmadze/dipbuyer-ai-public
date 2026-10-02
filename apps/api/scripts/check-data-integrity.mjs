/**
 * Data-integrity invariants — run against LIVE APIs, not mocks.
 *
 *   node apps/api/scripts/check-data-integrity.mjs
 *   (exit 0 = all invariants hold, 1 = at least one violated)
 *
 * WHY THIS EXISTS
 * Four bugs shipped through a green unit suite on 2026-07-19, all the same shape: a data path
 * failed and returned something PLAUSIBLE instead of raising. Frozen prices, a zeroed benchmark,
 * truncated filings, split-corrupted history. Unit mocks could not catch any of them, because the
 * mocks encoded our assumptions about the API rather than its actual behaviour — so they
 * confirmed the bugs instead of failing on them.
 *
 * Every check below is a bug we actually shipped. They hit the real network deliberately: that is
 * the only place this class of fault is observable. Keep them OUT of `pnpm test` (network-bound,
 * rate-limited) and run in CI on a schedule, or before trusting any backtest number.
 */
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));

const { AlpacaMarketData, SecEdgarFundamentals } = await import("@dipbuyer/data");

const results = [];
const check = async (name, why, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, why });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message, why });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const alpaca =
  process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY
    ? new AlpacaMarketData({
        keyId: process.env.ALPACA_KEY_ID,
        secretKey: process.env.ALPACA_SECRET_KEY,
        feed: process.env.ALPACA_DATA_FEED ?? "iex",
      })
    : null;
const edgar = process.env.SEC_EDGAR_USER_AGENT
  ? new SecEdgarFundamentals({ userAgent: process.env.SEC_EDGAR_USER_AGENT })
  : null;

const CLOCKS = [
  "2023-01-01", "2023-07-01", "2024-01-01", "2024-07-01",
  "2025-01-01", "2025-07-01", "2025-12-27",
];

if (alpaca) {
  await check(
    "prices advance across the window",
    "Alpaca paginates at 1000 bars; ignoring next_page_token froze every price after 2024-07-16 " +
      "at 564.83, so 18 months of backtest marked at a stale close with no error raised.",
    async () => {
      const prices = [];
      for (const c of CLOCKS) prices.push(await alpaca.getLatestPrice("SPY", `${c}T00:00:00Z`));
      const distinct = new Set(prices).size;
      assert(
        distinct === prices.length,
        `SPY returned ${distinct} distinct prices across ${prices.length} clocks — a repeated ` +
          `value means the series is truncated/frozen: ${prices.join(", ")}`,
      );
      // Directional sanity: a multi-year equity index should not be flat.
      const drift = Math.abs((prices.at(-1) - prices[0]) / prices[0]) * 100;
      assert(drift > 5, `SPY moved only ${drift.toFixed(1)}% over 3 years — implausible`);
      return `${prices.length} distinct closes, ${drift.toFixed(1)}% total move`;
    },
  );

  await check(
    "pagination is followed on long ranges",
    "A single page caps at 1000 bars. If a multi-year daily request returns exactly 1000, the " +
      "adapter is silently dropping the tail.",
    async () => {
      const bars = await alpaca.getBars("SPY", "2019-01-01T00:00:00Z", "2025-12-27T00:00:00Z", "1Day");
      assert(bars.length > 1000, `got ${bars.length} bars — at or under one page, tail dropped`);
      const last = bars.at(-1);
      assert(
        last.ts.slice(0, 4) >= "2025",
        `last bar is ${last.ts.slice(0, 10)}, not near the requested end — series truncated`,
      );
      return `${bars.length} bars, last ${last.ts.slice(0, 10)}`;
    },
  );

  await check(
    "benchmark is priceable at both ends of the window",
    "A benchmark that never priced produced benchmarkRelativePct = totalReturn - 0, so a total " +
      "data failure read as 'beat the market'. Index tickers like ^GSPC are not tradeable symbols.",
    async () => {
      const first = await alpaca.getLatestPrice("SPY", `${CLOCKS[0]}T00:00:00Z`);
      const last = await alpaca.getLatestPrice("SPY", `${CLOCKS.at(-1)}T00:00:00Z`);
      assert(first > 0 && last > 0, "benchmark unpriceable at a window edge");
      assert(first !== last, "benchmark identical at both ends — series not advancing");
      return `${first} -> ${last}`;
    },
  );

  await check(
    "point-in-time prices never see the future",
    "The live 'latest bar' endpoint returns NOW, which would leak future prices into a backtest.",
    async () => {
      const asOf = "2024-01-01T00:00:00Z";
      const p = await alpaca.getLatestPrice("SPY", asOf);
      const later = await alpaca.getLatestPrice("SPY", "2025-12-27T00:00:00Z");
      assert(p < later, `price at 2024-01-01 (${p}) not below 2025-12-27 (${later})`);
      const bars = await alpaca.getBars("SPY", "2023-12-01T00:00:00Z", asOf, "1Day");
      assert(
        bars.every((b) => b.ts <= asOf),
        "getBars returned a bar dated after the requested end — look-ahead",
      );
      return `no future bars at ${asOf.slice(0, 10)}`;
    },
  );
}

if (edgar) {
  await check(
    "fundamentals never predate the filing date",
    "EDGAR filters on report_period (fiscal END), not filing date. Aggregators expose only the " +
      "former, which is why the paid path needs a 90d lag estimate. Here it must be exact.",
    async () => {
      // AAPL FY2025 ended 2025-09-27 but was filed 2025-10-31.
      const before = await edgar.getFundamentals("AAPL", "2025-10-01");
      const after = await edgar.getFundamentals("AAPL", "2025-11-01");
      assert(
        before.asOf < "2025-09-27",
        `clock 2025-10-01 saw period ${before.asOf} — FY2025 was not filed until 2025-10-31`,
      );
      assert(after.asOf === "2025-09-27", `clock 2025-11-01 should see FY2025, saw ${after.asOf}`);
      return `${before.asOf} -> ${after.asOf} across the filing date`;
    },
  );

  await check(
    "asOf advances with the clock and never exceeds it",
    "asOf reporting the request clock rather than the newest period END overstates freshness.",
    async () => {
      for (const c of ["2024-01-01", "2025-01-01", "2026-01-01"]) {
        const f = await edgar.getFundamentals("AAPL", c);
        assert(f.asOf <= c, `asOf ${f.asOf} is AFTER the clock ${c} — look-ahead`);
      }
      const early = await edgar.getFundamentals("AAPL", "2024-01-01");
      const late = await edgar.getFundamentals("AAPL", "2026-01-01");
      assert(early.asOf < late.asOf, `asOf did not advance: ${early.asOf} vs ${late.asOf}`);
      return `${early.asOf} -> ${late.asOf}`;
    },
  );

  await check(
    "EPS history is free of stock-split artifacts",
    "EDGAR serves AS-FILED values, not split-adjusted across filings. AAPL FY2009 EPS is on " +
      "record as 9.08 (pre 7:1 and 4:1 splits) vs 7.46 for FY2025, so a long window produced " +
      "fictitious swings (-77%, +137%) that were splits, not earnings.",
    async () => {
      for (const sym of ["AAPL", "MSFT"]) {
        const f = await edgar.getFundamentals(sym, "2026-07-19");
        const worst = Math.max(0, ...f.epsGrowthHistoryPct.map(Math.abs));
        assert(
          worst < 200,
          `${sym} EPS history contains a ${worst.toFixed(0)}% step — likely a split artifact: ` +
            `[${f.epsGrowthHistoryPct.map((x) => x.toFixed(1)).join(", ")}]`,
        );
      }
      return "no |growth| >= 200% in the trailing window";
    },
  );

  await check(
    "derived ratios are within plausible bounds",
    "Raw XBRL concepts vary by filer; a mis-mapped tag yields numbers that are wrong but " +
      "structurally valid, which nothing downstream would reject.",
    async () => {
      const f = await edgar.getFundamentals("MSFT", "2026-07-19");
      assert(f.salesUsd > 1e10, `MSFT revenue ${f.salesUsd} implausibly small — tag mis-mapped?`);
      assert(f.roePct > 0 && f.roePct < 300, `MSFT ROE ${f.roePct} out of plausible range`);
      assert(f.debtToEquity >= 0 && f.debtToEquity < 20, `MSFT D/E ${f.debtToEquity} implausible`);
      assert(f.currentRatio > 0 && f.currentRatio < 20, `MSFT current ratio ${f.currentRatio} implausible`);
      return `revenue ${(f.salesUsd / 1e9).toFixed(0)}bn, ROE ${f.roePct.toFixed(0)}%, D/E ${f.debtToEquity.toFixed(2)}`;
    },
  );

  await check(
    "provenance reports the real source, never a demo fallback",
    "A silent fallback to fixtures would let demo data masquerade as real analysis in signed " +
      "proofs and on-chain anchored records.",
    async () => {
      assert(edgar.sourceId === "sec-edgar", `unexpected sourceId ${edgar.sourceId}`);
      const f = await edgar.getFundamentals("AAPL", "2026-07-19");
      assert(f.symbol === "AAPL" && f.asOf, "adapter returned an empty record");
      return `sourceId=${edgar.sourceId}`;
    },
  );
}

if (!alpaca && !edgar) {
  console.error("No data sources configured (ALPACA_KEY_ID / SEC_EDGAR_USER_AGENT) — nothing to check.");
  process.exit(1);
}

let failed = 0;
console.log("\nDATA INTEGRITY INVARIANTS  (live APIs — unit mocks cannot catch these)\n");
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`   ${r.ok ? r.detail : r.detail}`);
  if (!r.ok) console.log(`   WHY THIS MATTERS: ${r.why}`);
}
console.log(`\n${results.length - failed}/${results.length} invariants hold.`);
if (failed) {
  console.log("\n⚠️  Do not trust backtest or decision output until these pass.");
  process.exit(1);
}
