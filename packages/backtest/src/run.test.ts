import { describe, expect, it, vi } from "vitest";
import type { Fundamentals } from "@dipbuyer/shared";
import { InMemoryFundamentals, InMemoryMarketData, type PriceBar } from "@dipbuyer/data";
import { runBacktest } from "./run.js";
import type { BacktestParams } from "./index.js";

const fund = (asOf: string, over: Partial<Fundamentals>): Fundamentals =>
  ({ symbol: "AAA", asOf, peRatio: 12, epsGrowthPct: 25, epsGrowthHistoryPct: [22, 24, 25], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: 30, inventoryGrowthPct: 10, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: 18, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null, ...over }) as Fundamentals;

const bar = (ts: string, close: number): PriceBar => ({ symbol: "AAA", ts, open: close, high: close, low: close, close, volume: 1_000_000 });

const params: BacktestParams = {
  universe: ["AAA"],
  from: "2026-01-01T00:00:00Z",
  to: "2026-04-01T00:00:00Z",
  rebalance: "monthly",
  initialCapital: 10_000,
  frictions: { commissionBps: 0, slippageBps: 0, spreadBps: 0 },
  benchmark: "^GSPC",
  seed: 1,
  // Disable caps so these mechanic-focused tests deploy full capital into the single name.
  risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 },
};

describe("runBacktest (end-to-end, point-in-time)", () => {
  it("buys a cheap fast grower and grows equity as price rises", async () => {
    const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
    const fundamentals = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 12 })]]]));
    const marketData = new InMemoryMarketData(
      new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 12), bar("2026-03-31T00:00:00Z", 15)]]]),
    );

    const result = await runBacktest(params, { fundamentals, marketData, schedule });

    expect(result.equityCurve).toHaveLength(3);
    // Bought ~1000 shares @10 (~10k), rises to 15 → portfolio should end above starting capital.
    expect(result.equityCurve.at(-1)!.value).toBeGreaterThan(params.initialCapital);
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
  });

  it("does NOT trade before fundamentals exist (no look-ahead)", async () => {
    const schedule = ["2025-06-30T00:00:00Z"]; // before any fundamentals/prices
    const fundamentals = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", {})]]]));
    const marketData = new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10)]]]));

    const result = await runBacktest(params, { fundamentals, marketData, schedule });
    // No price as of clock → no trade → equity stays at cash.
    expect(result.equityCurve[0]!.value).toBe(params.initialCapital);
  });

  it("exits when the engine flags overvaluation (PEG>=2 sell)", async () => {
    const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    // Cheap in Jan (buy), expensive snapshot from Feb (PE 60 / growth 25 = PEG 2.4 → sell).
    const fundamentals = new InMemoryFundamentals(
      new Map([["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 12 }), fund("2026-02-15T00:00:00Z", { peRatio: 60 })]]]),
    );
    const marketData = new InMemoryMarketData(
      new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 12)]]]),
    );

    const result = await runBacktest(params, { fundamentals, marketData, schedule });
    // After the Feb sell, the portfolio is back in cash (no open position contribution beyond realised).
    expect(result.equityCurve).toHaveLength(2);
    expect(result.metrics.turnoverPct).toBeGreaterThan(0);
  });
});

describe("runBacktest risk guardrails", () => {
  const schedule = ["2026-01-31T00:00:00Z"];
  const buyable = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 12 })]]]));

  it("clamps a single-name buy to the per-name position cap (rest stays in cash)", async () => {
    const marketData = new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10)]]]));
    // Default 10% cap on 10k → ~1,000 invested (100 sh @10), ~9,000 cash.
    const result = await runBacktest({ ...params, risk: undefined }, { fundamentals: buyable, marketData, schedule });
    expect(result.equityCurve[0]!.value).toBeCloseTo(10_000, 0); // no price move → flat
    // Exactly one buy of 100 shares. Asserted directly rather than inferred from turnoverPct,
    // which is now notional-weighted and annualised (undefined over a single clock).
    expect(result.orders).toBe(1);
    // Position is 100 sh * $10 = $1,000 = 10% of 10k; verify via a second flat period unchanged.
    const two = await runBacktest(
      { ...params, risk: undefined },
      { fundamentals: buyable, marketData: new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 20)]]])), schedule: ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"] },
    );
    // 100 sh doubles to $2,000; cash $9,000 → $11,000 (not $20k, proving the cap bound the size).
    expect(two.equityCurve.at(-1)!.value).toBeCloseTo(11_000, 0);
    // Cash weight is reported, not inferred: 9,000/10,000 = 90% at Jan, 9,000/11,000 = 81.82% at
    // Feb → average 85.91%. This is the idle-cash drag against a fully-invested benchmark.
    expect(result.metrics.avgCashPct).toBeCloseTo(90, 6);
    expect(two.metrics.avgCashPct).toBeCloseTo((90 + (9_000 / 11_000) * 100) / 2, 6);
  });

  it("excludes penny stocks below the price floor", async () => {
    const marketData = new InMemoryMarketData(new Map([["AAA", [bar("2026-01-31T00:00:00Z", 0.5)]]]));
    const result = await runBacktest(
      { ...params, risk: { minPriceUsd: 1 } },
      { fundamentals: buyable, marketData, schedule },
    );
    expect(result.metrics.turnoverPct).toBe(0); // no order placed
    expect(result.metrics.avgCashPct).toBe(100); // never invested
    expect(result.equityCurve[0]!.value).toBe(params.initialCapital);
  });

  it("respects the max concurrent-positions cap", async () => {
    const twoNames = new InMemoryFundamentals(
      new Map([
        ["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 12 })]],
        ["BBB", [{ ...fund("2026-01-01T00:00:00Z", { peRatio: 12 }), symbol: "BBB" }]],
      ]),
    );
    const marketData = new InMemoryMarketData(
      new Map([
        ["AAA", [bar("2026-01-31T00:00:00Z", 10)]],
        ["BBB", [{ ...bar("2026-01-31T00:00:00Z", 10), symbol: "BBB" }]],
      ]),
    );
    const result = await runBacktest(
      { ...params, universe: ["AAA", "BBB"], risk: { maxPositions: 1, maxPositionPct: 100, minCashFloorPct: 0 } },
      { fundamentals: twoNames, marketData, schedule },
    );
    expect(result.orders).toBe(1); // exactly 1 buy despite 2 candidates
  });

  it("excludes illiquid names below the average-daily-dollar-volume floor", async () => {
    // price 10 * volume 50,000 = $500k ADV < $1M default floor → no buy.
    const illiquid: PriceBar = { symbol: "AAA", ts: "2026-01-31T00:00:00Z", open: 10, high: 10, low: 10, close: 10, volume: 50_000 };
    const marketData = new InMemoryMarketData(new Map([["AAA", [illiquid]]]));
    const result = await runBacktest(
      { ...params, risk: { minAdvUsd: 1_000_000, maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
      { fundamentals: buyable, marketData, schedule },
    );
    expect(result.metrics.turnoverPct).toBe(0);
    expect(result.equityCurve[0]!.value).toBe(params.initialCapital);
  });

  it("clamps same-sector buys to the per-sector concentration cap", async () => {
    const twoTech = new InMemoryFundamentals(
      new Map([
        ["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 12 })]],
        ["BBB", [{ ...fund("2026-01-01T00:00:00Z", { peRatio: 12 }), symbol: "BBB" }]],
      ]),
    );
    const marketData = new InMemoryMarketData(
      new Map([
        ["AAA", [bar("2026-01-31T00:00:00Z", 10)]],
        ["BBB", [{ ...bar("2026-01-31T00:00:00Z", 10), symbol: "BBB" }]],
      ]),
    );
    // Sector cap 30% of 10k = 3,000 for "tech"; AAA fills it → BBB (same sector) gets no headroom.
    const result = await runBacktest(
      { ...params, universe: ["AAA", "BBB"], risk: { maxSectorPct: 30, maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
      { fundamentals: twoTech, marketData, schedule, sectorOf: () => "tech" },
    );
    expect(result.orders).toBe(1); // only AAA bought; BBB sector-capped out
  });

  it("computes benchmark-relative return from a real benchmark buy-and-hold", async () => {
    const schedule2 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const marketData = new InMemoryMarketData(
      new Map([
        ["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 20)]], // +100%
        ["^GSPC", [{ ...bar("2026-01-31T00:00:00Z", 100), symbol: "^GSPC" }, { ...bar("2026-02-28T00:00:00Z", 110), symbol: "^GSPC" }]], // +10%
      ]),
    );
    const result = await runBacktest(
      { ...params, risk: { maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
      { fundamentals: buyable, marketData, schedule: schedule2 },
    );
    // Strategy fully invested → ~+100%; benchmark +10% → relative ≈ +90 points.
    expect(result.metrics.benchmarkRelativePct).toBeCloseTo(result.metrics.totalReturnPct - 10, 5);
    expect(result.metrics.benchmarkRelativePct!).toBeGreaterThan(80);
  });

  it("sizes by QUALIFYING names, not universe size — a wider universe must not shrink exposure", async () => {
    // REGRESSION: sizing was `initialCapital / universe.length`, so $10k across a 46-name
    // universe was $217 a position. Ten buy candidates deployed ~22% of capital and the rest sat
    // in cash forever — a 46-name real run returned 3.43% CAGR with a 4.14% max drawdown while
    // the index roughly doubled. Widening the universe REDUCED exposure, which is backwards.
    const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const buyable = fund("2026-01-01T00:00:00Z", { peRatio: 12 });
    const junk = fund("2026-01-01T00:00:00Z", { peRatio: 200, epsGrowthPct: 1, debtToEquity: 5 });

    // 2 buyable names inside a 10-name universe; the other 8 must never qualify.
    const universe = ["AAA", "BBB", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
    const fmap = new Map(
      universe.map((s) => [s, [{ ...(s === "AAA" || s === "BBB" ? buyable : junk), symbol: s }]]),
    );
    // The two qualifying names rise +50%; everything else stays flat. Final equity therefore
    // MEASURES how much capital was actually deployed — no need to inspect positions.
    const bmap = new Map(
      universe.map((s) => {
        const rises = s === "AAA" || s === "BBB";
        return [
          s,
          [
            { ...bar(schedule[0]!, 10), symbol: s },
            { ...bar(schedule[1]!, rises ? 15 : 10), symbol: s },
          ],
        ] as const;
      }),
    );

    const result = await runBacktest(
      { ...params, universe, risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 } },
      {
        fundamentals: new InMemoryFundamentals(fmap),
        marketData: new InMemoryMarketData(bmap as never),
        schedule,
      },
    );

    // Old sizing: 10_000/10 = $1,000 each -> $2,000 deployed -> +50% on that = ~$11,000 (+10%).
    // New sizing: equity/2 qualifying = $5,000 each -> $10,000 deployed -> ~$15,000 (+50%).
    const finalEquity = result.equityCurve.at(-1)!.value;
    expect(finalEquity).toBeGreaterThan(13_000);
  });

  it("reports NULL — never a market-beating number — when the benchmark cannot be priced", async () => {
    // REGRESSION: an unpriceable benchmark (e.g. the index ticker ^GSPC, which Alpaca rejects as
    // an invalid symbol) used to fall back to `totalReturn - 0`. A real 46-name run that trailed
    // the S&P by 71 points therefore reported +10.30 relative — a total data failure presented as
    // outperformance. A missing comparison must read as missing.
    const schedule2 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const marketData = new InMemoryMarketData(
      new Map([["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 20)]]]), // no benchmark
    );
    const result = await runBacktest(
      { ...params, benchmark: "NOT_A_SYMBOL", risk: { maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
      { fundamentals: buyable, marketData, schedule: schedule2 },
    );
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0); // strategy itself still measured
    expect(result.metrics.benchmarkRelativePct).toBeNull();
  });

  it("point-in-time universe: a departed name stays SELLABLE but stops being BUYABLE", async () => {
    // Survivorship fix. Two distinct failures are guarded here, and they pull in opposite
    // directions — which is why the screen covers the UNION but the buy filter does not:
    //  (a) if a departed name were dropped from screening entirely, its position would never be
    //      evaluated again — held forever, marked at a stale price, quietly inflating equity;
    //  (b) if a departed name stayed buyable, we would be buying it BECAUSE we know it survived
    //      into today's list. That is look-ahead of the worst kind.
    const schedule3 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
    const buyableFund = fund("2026-01-01T00:00:00Z", { peRatio: 12 });
    const fmap = new Map(
      ["AAA", "GONE"].map((s): [string, Fundamentals[]] => [s, [{ ...buyableFund, symbol: s }]]),
    );
    const bars = (s: string) => [
      { ...bar(schedule3[0]!, 10), symbol: s },
      { ...bar(schedule3[1]!, 12), symbol: s },
      { ...bar(schedule3[2]!, 14), symbol: s },
    ];
    const marketData = new InMemoryMarketData(
      new Map([["AAA", bars("AAA")], ["GONE", bars("GONE")]] as never),
    );

    // GONE is in the index at the first clock, then leaves. AAA is present throughout.
    const universeAt = (clock: string) => (clock === schedule3[0] ? ["AAA", "GONE"] : ["AAA"]);

    const result = await runBacktest(
      {
        ...params,
        universe: ["AAA", "GONE"],
        benchmark: "AAA",
        risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 },
      },
      { fundamentals: new InMemoryFundamentals(fmap), marketData, schedule: schedule3, universeAt },
    );

    const decidedAt = (clock: string) =>
      result.decisionRecords.filter((r) => r.ts === clock).map((r) => r.symbol);
    // Bought while a member...
    expect(decidedAt(schedule3[0]!)).toContain("GONE");
    // ...and STILL screened after departure, because it is held (guard (a)). Only the held-union
    // path can produce this: universeAt returns just ["AAA"] at that clock.
    expect(decidedAt(schedule3[2]!)).toContain("GONE");
    // Guard (b) — that departure removes BUYABILITY — is asserted in the next test, where the
    // departed name is the only qualifying candidate and so shows up in final equity.
  });

  it("point-in-time universe: buys only from the CURRENT membership", async () => {
    // The departed name is the only BUY candidate; if the filter leaked, capital would deploy into
    // it. Equity therefore measures whether the look-ahead buy happened, with no need to inspect
    // positions directly.
    const schedule2 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const buyableFund = fund("2026-01-01T00:00:00Z", { peRatio: 12 });
    const junk = fund("2026-01-01T00:00:00Z", { peRatio: 200, epsGrowthPct: 1, debtToEquity: 5 });
    const fmap = new Map<string, Fundamentals[]>([
      ["AAA", [{ ...junk, symbol: "AAA" }]], // never qualifies
      ["GONE", [{ ...buyableFund, symbol: "GONE" }]], // qualifies, but is NOT a member
    ]);
    const marketData = new InMemoryMarketData(
      new Map([
        ["AAA", [{ ...bar(schedule2[0]!, 10), symbol: "AAA" }, { ...bar(schedule2[1]!, 10), symbol: "AAA" }]],
        // GONE doubles — if it were wrongly bought, final equity would jump.
        ["GONE", [{ ...bar(schedule2[0]!, 10), symbol: "GONE" }, { ...bar(schedule2[1]!, 20), symbol: "GONE" }]],
      ] as never),
    );

    const result = await runBacktest(
      {
        ...params,
        universe: ["AAA", "GONE"],
        benchmark: "AAA",
        risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 },
      },
      {
        fundamentals: new InMemoryFundamentals(fmap),
        marketData,
        schedule: schedule2,
        universeAt: () => ["AAA"], // GONE is never a member at any clock
      },
    );

    // Nothing investable ever qualified, so capital stays put at the initial 10k.
    expect(result.equityCurve.at(-1)!.value).toBeCloseTo(params.initialCapital, 5);
  });

  it("liquidates a held name that stops trading, instead of carrying it at a stale mark", async () => {
    // Without this the survivorship fix is COSMETIC: a name like SIVB enters the universe, is
    // bought, collapses, halts — and is then held at its last mark for the rest of the run, so
    // the loss never lands. The bought-at price is 10 and the last observed price is 5, so a
    // correct exit realises a loss; carrying it would leave equity at ~10k.
    const schedule3 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
    const inner = new InMemoryMarketData(
      new Map([["AAA", [bar(schedule3[0]!, 10), bar(schedule3[1]!, 5), bar(schedule3[2]!, 5)]]]),
    );
    // Stops trading after the second clock — a genuine absence, NOT a transport failure.
    const marketData = {
      ...inner,
      getBars: inner.getBars.bind(inner),
      getLatestPrice: async (symbol: string, asOf?: string) => {
        if (asOf === schedule3[2]) throw new Error(`No price for ${symbol} as of ${asOf}`);
        return inner.getLatestPrice(symbol, asOf);
      },
    } as unknown as InMemoryMarketData;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runBacktest(
        {
          ...params,
          universe: ["AAA"],
          benchmark: "AAA",
          risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 },
        },
        { fundamentals: buyable, marketData, schedule: schedule3 },
      );
      // Bought ~1000 shares at 10 then exited at 5 → roughly half of capital lost. If the position
      // were carried at its stale mark this would still be ~10k.
      const finalEquity = result.equityCurve.at(-1)!.value;
      expect(finalEquity).toBeLessThan(6_500);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("stopped");
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT liquidate on a transport failure — throttling is not delisting", async () => {
    // Bug #5's shape. A 429 must never be read as "this company ceased to exist" and trigger a
    // forced exit; that would delete real holdings from the run whenever the API rate-limited us.
    const schedule3 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
    const inner = new InMemoryMarketData(
      new Map([["AAA", [bar(schedule3[0]!, 10), bar(schedule3[1]!, 12), bar(schedule3[2]!, 14)]]]),
    );
    const marketData = {
      ...inner,
      getBars: inner.getBars.bind(inner),
      getLatestPrice: async (symbol: string, asOf?: string) => {
        if (asOf === schedule3[2]) throw new Error("alpaca bars AAA: HTTP 429");
        return inner.getLatestPrice(symbol, asOf);
      },
    } as unknown as InMemoryMarketData;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runBacktest(
        {
          ...params,
          universe: ["AAA"],
          benchmark: "AAA",
          risk: { maxPositionPct: 100, minCashFloorPct: 0, maxPositions: 40, minPriceUsd: 0 },
        },
        { fundamentals: buyable, marketData, schedule: schedule3 },
      );
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("DATA-SOURCE FAILURES"); // surfaced as a broken run...
      expect(messages).not.toContain("stopped trading"); // ...NOT as a delisting
      // Position retained and still marked at its last good price, so equity holds up.
      expect(result.equityCurve.at(-1)!.value).toBeGreaterThan(9_000);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns LOUDLY when a name prices but has no fundamentals", async () => {
    // The failure that made the point-in-time universe cosmetic on real data: SEC EDGAR resolves
    // tickers via a CURRENT-STATE map, so SIVB/FRC/ATVI have no CIK and every fundamentals lookup
    // fails — while Alpaca prices them perfectly well. The names sat in the universe and were
    // silently skipped, so the run LOOKED survivorship-controlled and was not.
    const schedule2 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"];
    const marketData = new InMemoryMarketData(
      new Map([
        ["AAA", [bar(schedule2[0]!, 10), bar(schedule2[1]!, 12)]],
        ["DEAD", [{ ...bar(schedule2[0]!, 20), symbol: "DEAD" }, { ...bar(schedule2[1]!, 22), symbol: "DEAD" }]],
      ] as never),
    );
    // Fundamentals exist for AAA only — DEAD prices fine but can never be screened.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runBacktest(
        { ...params, universe: ["AAA", "DEAD"], benchmark: "AAA", risk: { maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
        { fundamentals: buyable, marketData, schedule: schedule2 },
      );
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("NO FUNDAMENTALS");
      expect(messages).toContain("DEAD");
      expect(messages).toContain("SURVIVORSHIP CONTROL IS THEREFORE INCOMPLETE");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when the benchmark prices over a SHORTER span than the strategy", async () => {
    // REGRESSION (same shape as the five 2026-07-19 data bugs): the only benchmark guard fired
    // when the benchmark priced at NO clock. A benchmark that priced at SOME clocks produced a
    // plausible number with no signal at all — and because buy-and-hold is measured first-to-last,
    // a missing FINAL clock measures the benchmark over a shorter window than the strategy and
    // books the truncated tail as alpha. Here the benchmark stops one clock early while it is
    // RISING, so the strategy is credited with gains the index also made.
    const schedule3 = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
    const inner = new InMemoryMarketData(
      new Map([
        ["AAA", [bar(schedule3[0]!, 10), bar(schedule3[1]!, 15), bar(schedule3[2]!, 20)]],
        [
          "BENCH",
          [
            { ...bar(schedule3[0]!, 100), symbol: "BENCH" },
            { ...bar(schedule3[1]!, 110), symbol: "BENCH" },
            { ...bar(schedule3[2]!, 120), symbol: "BENCH" },
          ],
        ],
      ]),
    );
    // InMemoryMarketData carries the last known bar forward, so simply omitting the final bar
    // would NOT reproduce this — it would price 110 and stay aligned. The real failure is the
    // source REFUSING at a clock (an Alpaca 429/5xx after retries), so throw exactly there.
    const marketData = {
      ...inner,
      getBars: inner.getBars.bind(inner),
      getLatestPrice: async (symbol: string, asOf?: string) => {
        if (symbol === "BENCH" && asOf === schedule3[2]) throw new Error("alpaca bars BENCH: HTTP 429");
        return inner.getLatestPrice(symbol, asOf);
      },
    } as unknown as InMemoryMarketData;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runBacktest(
        { ...params, benchmark: "BENCH", risk: { maxPositionPct: 100, minCashFloorPct: 0, minPriceUsd: 0 } },
        { fundamentals: buyable, marketData, schedule: schedule3 },
      );
      // A number is still produced — that is exactly why this needs to be loud rather than silent.
      expect(result.metrics.benchmarkRelativePct).not.toBeNull();
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("TWO DIFFERENT WINDOWS");
      expect(messages).toContain("Do not cite it");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runBacktest cash policies", () => {
  const schedule = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];
  // Nothing is buyable (PEG 60/25 = 2.4 -> sell), so the whole book is idle cash.
  const expensive = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 60 })]]]));
  const spyBar = (ts: string, close: number): PriceBar => ({ ...bar(ts, close), symbol: "SPY" });
  const marketData = new InMemoryMarketData(
    new Map([
      ["AAA", [bar("2026-01-31T00:00:00Z", 10), bar("2026-02-28T00:00:00Z", 10), bar("2026-03-31T00:00:00Z", 10)]],
      ["SPY", [spyBar("2026-01-31T00:00:00Z", 100), spyBar("2026-02-28T00:00:00Z", 110), spyBar("2026-03-31T00:00:00Z", 121)]],
    ]),
  );
  const base = { ...params, benchmark: "SPY" };

  it("none: idle cash earns nothing (the default, unchanged)", async () => {
    const r = await runBacktest(base, { fundamentals: expensive, marketData, schedule, cashRatePct: () => 5 });
    expect(r.equityCurve.at(-1)!.value).toBe(10_000);
  });

  it("tbill: accrues the rate known at the start of each period, never in advance", async () => {
    const rates: Record<string, number> = { "2026-01-31T00:00:00Z": 3.65, "2026-02-28T00:00:00Z": 7.3 };
    const r = await runBacktest({ ...base, cashPolicy: "tbill" }, { fundamentals: expensive, marketData, schedule, cashRatePct: (c) => rates[c] ?? null });
    const feb = 10_000 * (1 + 0.0365 * (28 / 365));
    const mar = feb * (1 + 0.073 * (31 / 365));
    expect(r.equityCurve[0]!.value).toBe(10_000); // first clock: no elapsed period yet
    expect(r.equityCurve[1]!.value).toBeCloseTo(feb, 6);
    expect(r.equityCurve[2]!.value).toBeCloseTo(mar, 6);
    expect(r.metrics.cashInterestPct).toBeCloseTo(((mar - 10_000) / 10_000) * 100, 6);
  });

  it("benchmark: parks idle cash in the benchmark and never screens or counts it as a pick", async () => {
    const fundamentals = { sourceId: "t", getFundamentals: vi.fn(expensive.getFundamentals.bind(expensive)) };
    const r = await runBacktest({ ...base, cashPolicy: "benchmark" }, { fundamentals, marketData, schedule });
    // Fully in SPY after the first clock: 10k -> +10% -> +10% (1 bp friction each way).
    expect(r.equityCurve.at(-1)!.value).toBeGreaterThan(12_000);
    expect(r.equityCurve.at(-1)!.value).toBeLessThan(12_100);
    expect(r.metrics.avgSleevePct).toBeGreaterThan(99);
    expect(fundamentals.getFundamentals.mock.calls.some(([s]) => s === "SPY")).toBe(false);
  });

  it("benchmark: picks are funded first — the sleeve is sold before buys", async () => {
    const cheapFromFeb = new InMemoryFundamentals(
      new Map([["AAA", [fund("2026-01-01T00:00:00Z", { peRatio: 60 }), fund("2026-02-15T00:00:00Z", { peRatio: 12 })]]]),
    );
    const r = await runBacktest({ ...base, cashPolicy: "benchmark" }, { fundamentals: cheapFromFeb, marketData, schedule });
    // In March the book is AAA (bought in Feb with the sleeve proceeds), so SPY's +10% in March is missed.
    expect(r.equityCurve.at(-1)!.value).toBeCloseTo(r.equityCurve[1]!.value, 0);
  });
});

describe("runBacktest dip entry", () => {
  const cheap = new InMemoryFundamentals(new Map([["AAA", [fund("2025-01-01T00:00:00Z", { peRatio: 12 })]]]));
  // 250 daily bars: flat at 100, then a slide to 80 and a bounce to 85 at the clock.
  const series = (path: (i: number) => number) =>
    new InMemoryMarketData(
      new Map([["AAA", Array.from({ length: 250 }, (_, i) => bar(new Date(Date.UTC(2025, 3, 1) + i * 86_400_000).toISOString(), path(i)))]]),
    );
  const clock = new Date(Date.UTC(2025, 3, 1) + 249 * 86_400_000).toISOString();
  const run = (md: InMemoryMarketData, dipEntry: BacktestParams["dipEntry"]) =>
    runBacktest({ ...params, dipEntry }, { fundamentals: cheap, marketData: md, schedule: [clock] });

  it("buys only when the price is far enough below its 52-week high", async () => {
    const atHigh = series(() => 100);
    expect((await run(atHigh, { minDrawdownPct: 15, requireStabilization: false })).orders).toBe(0);
    const dipped = series((i) => (i < 200 ? 100 : i < 240 ? 80 : 85));
    expect((await run(dipped, { minDrawdownPct: 15, requireStabilization: false })).orders).toBe(1);
  });

  it("with stabilisation, skips a knife that is still falling", async () => {
    const falling = series((i) => (i < 200 ? 100 : 100 - (i - 199) * 0.5)); // 75.5 and still dropping
    expect((await run(falling, { minDrawdownPct: 15, requireStabilization: false })).orders).toBe(1);
    expect((await run(falling, { minDrawdownPct: 15, requireStabilization: true })).orders).toBe(0);
  });
});

describe("runBacktest portfolio rules", () => {
  const months = ["2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z", "2026-03-31T00:00:00Z"];

  it("hard-rules sell policy holds a name that merely drops to avoid; the default sells it", async () => {
    // Jan: cheap fast grower (buy). Feb: PEG 1.2, D/E 0.5 and shaky growth -> avoid, but no sell rule
    // (PEG < 2) and no hard limit (D/E <= 0.8).
    const fundamentals = () =>
      new InMemoryFundamentals(
        new Map([["AAA", [fund("2026-01-01T00:00:00Z", {}), fund("2026-02-15T00:00:00Z", { peRatio: 30, debtToEquity: 0.5, epsGrowthHistoryPct: [-5, -3, 25] })]]]),
      );
    const marketData = () => new InMemoryMarketData(new Map([["AAA", [bar(months[0]!, 10), bar(months[1]!, 11)]]]));
    const schedule = months.slice(0, 2);
    const avoidSells = await runBacktest(params, { fundamentals: fundamentals(), marketData: marketData(), schedule });
    const hardRules = await runBacktest({ ...params, sellPolicy: "hard-rules" }, { fundamentals: fundamentals(), marketData: marketData(), schedule });
    expect(avoidSells.orders).toBe(2); // buy, then sell on avoid
    expect(hardRules.orders).toBe(1); // buy only: still held
  });

  it("hard-rules still sells on a hard limit breach", async () => {
    const fundamentals = new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", {}), fund("2026-02-15T00:00:00Z", { debtToEquity: 1.5 })]]]));
    const marketData = new InMemoryMarketData(new Map([["AAA", [bar(months[0]!, 10), bar(months[1]!, 11)]]]));
    const out = await runBacktest({ ...params, sellPolicy: "hard-rules" }, { fundamentals, marketData, schedule: months.slice(0, 2) });
    expect(out.orders).toBe(2);
  });

  it("takes profits on a stalwart after the gain threshold and does not buy it back during the cooldown", async () => {
    // Stalwart (15% growth, PEG 0.8, buy). +60% by Feb, still a buy.
    const stalwart = { epsGrowthPct: 15, epsGrowthHistoryPct: [14, 15, 15] };
    const fundamentals = () => new InMemoryFundamentals(new Map([["AAA", [fund("2026-01-01T00:00:00Z", stalwart)]]]));
    const marketData = () => new InMemoryMarketData(new Map([["AAA", [bar(months[0]!, 10), bar(months[1]!, 16), bar(months[2]!, 16)]]]));
    const hold = await runBacktest(params, { fundamentals: fundamentals(), marketData: marketData(), schedule: months });
    const take = await runBacktest(
      { ...params, profitTake: { gainPct: 50, categories: ["stalwart", "slow_grower"], cooldownPeriods: 6 } },
      { fundamentals: fundamentals(), marketData: marketData(), schedule: months },
    );
    expect(hold.orders).toBe(1); // bought once, held
    expect(take.orders).toBe(2); // bought, sold on the 60% gain, not re-bought in March
    const other = await runBacktest(
      { ...params, profitTake: { gainPct: 50, categories: ["fast_grower"], cooldownPeriods: 6 } },
      { fundamentals: fundamentals(), marketData: marketData(), schedule: months },
    );
    expect(other.orders).toBe(1); // a category outside the rule is never profit-taken
  });

  it("market-cap sizing weights new buys by market cap; equal sizing splits them evenly", async () => {
    // AAA is 9x BBB's size. AAA doubles in February, BBB is flat, so the February equity shows
    // how much went into each name: equal 10k -> 15k, market-cap 10k -> 19k.
    const fundamentals = () =>
      new InMemoryFundamentals(
        new Map([
          ["AAA", [fund("2026-01-01T00:00:00Z", { marketCapUsd: 9e11 })]],
          ["BBB", [fund("2026-01-01T00:00:00Z", { symbol: "BBB", marketCapUsd: 1e11 })]],
        ]),
      );
    const marketData = () =>
      new InMemoryMarketData(
        new Map([
          ["AAA", [bar(months[0]!, 10), bar(months[1]!, 20)]],
          ["BBB", [bar(months[0]!, 10), bar(months[1]!, 10)]],
        ]),
      );
    const schedule = months.slice(0, 2);
    const p = { ...params, universe: ["AAA", "BBB"] };
    const equal = await runBacktest(p, { fundamentals: fundamentals(), marketData: marketData(), schedule });
    const byCap = await runBacktest({ ...p, sizing: "market-cap" }, { fundamentals: fundamentals(), marketData: marketData(), schedule });
    expect(equal.equityCurve.at(-1)!.value).toBeCloseTo(15_000, 0);
    expect(byCap.equityCurve.at(-1)!.value).toBeCloseTo(19_000, 0);
  });

  it("sector-neutral sizing gives each sector its index weight, split among that sector's picks", async () => {
    // tech: AAA 3e11 (buy). fin: BBB 1e11 (buy) + CCC 4e11 (D/E 1.5 -> hard reject, not a pick).
    // Index weights: tech 3/8, fin 5/8. Picks: AAA takes all of tech, BBB all of fin. AAA doubles:
    // 10k -> 13,750 (market-cap sizing would put 3/4 in AAA -> 17,500).
    const fundamentals = () =>
      new InMemoryFundamentals(
        new Map([
          ["AAA", [fund("2026-01-01T00:00:00Z", { marketCapUsd: 3e11 })]],
          ["BBB", [fund("2026-01-01T00:00:00Z", { symbol: "BBB", marketCapUsd: 1e11 })]],
          ["CCC", [fund("2026-01-01T00:00:00Z", { symbol: "CCC", marketCapUsd: 4e11, debtToEquity: 1.5 })]],
        ]),
      );
    const marketData = () =>
      new InMemoryMarketData(
        new Map([
          ["AAA", [bar(months[0]!, 10), bar(months[1]!, 20)]],
          ["BBB", [bar(months[0]!, 10), bar(months[1]!, 10)]],
          ["CCC", [bar(months[0]!, 10), bar(months[1]!, 10)]],
        ]),
      );
    const sectorOf = (s: string) => (s === "AAA" ? "technology" : "financials");
    // Sector cap off so the test isolates the sizing rule (the default 30% cap would clamp tech to 13,000).
    const p = { ...params, universe: ["AAA", "BBB", "CCC"], sizing: "sector-neutral" as const, risk: { ...params.risk, maxSectorPct: 100 } };
    const out = await runBacktest(p, { fundamentals: fundamentals(), marketData: marketData(), schedule: months.slice(0, 2), sectorOf });
    expect(out.equityCurve.at(-1)!.value).toBeCloseTo(13_750, 0);
  });
});
