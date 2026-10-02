/**
 * Point-in-time, bias-controlled backtester. Reuses @dipbuyer/strategy so a backtest is a
 * faithful dry-run of live behaviour. CORRECTNESS GUARANTEES (the engineering design notes):
 *  - No look-ahead: only data with asOf <= simulatedClock is exposed.
 *  - Survivorship bias: CONDITIONAL, not guaranteed. Supply `RunDeps.universeAt` to screen the
 *    point-in-time index membership (delisted/acquired names included). With only the static
 *    `params.universe` — a list of names that exist TODAY — results ARE survivorship-biased and
 *    must be labelled indicative, never presented as strategy evidence.
 *  - Realistic frictions: commissions, fees, spread, slippage applied.
 *  - Reproducible: stamped with dataSnapshotId + strategyConfigHash + codeCommit + seed.
 */

export interface BacktestParams {
  universe: string[];
  from: string;
  to: string;
  rebalance: "daily" | "weekly" | "monthly" | "quarterly" | "annual";
  initialCapital: number;
  frictions: { commissionBps: number; slippageBps: number; spreadBps: number };
  /**
   * Benchmark symbol for relative return. MUST be one the market-data adapter can actually
   * price — index tickers like "^GSPC" are NOT tradeable symbols and Alpaca rejects them
   * ("invalid symbol"). Use a liquid ETF proxy: SPY (S&P 500), ISF.L / VUKE.L (FTSE 100).
   */
  benchmark: string;
  seed: number;
  /**
   * What idle cash does between rebalances. Default "none": it earns nothing, which is a drag a
   * fully-invested benchmark never pays.
   *  - "tbill": cash accrues the 3-month T-bill rate supplied by RunDeps.cashRatePct.
   *  - "benchmark": cash above the floor is parked in `benchmark` after each rebalance and sold
   *    first at the next one, so stock picks are always funded before the sleeve.
   */
  cashPolicy?: "none" | "tbill" | "benchmark";
  /**
   * Dip entry trigger for NEW buys (held positions are unaffected). A "buy" verdict is only acted on
   * when the price is at least `minDrawdownPct` below its trailing 52-week closing high and, with
   * `requireStabilization`, back above its 20-session average (not still falling). Omit to buy on
   * the verdict alone, which is what every run before 2026-09-17 did.
   */
  dipEntry?: { minDrawdownPct: number; requireStabilization: boolean };
  /**
   * When a held name is sold. "any-avoid" (default, every run before 2026-09-17): the verdict turns
   * sell OR avoid. "hard-rules": only a sell verdict (PEG >= 2 on a stalwart / fast grower) or a hard
   * limit breach (a checklist note starting "REJECT", e.g. debt to equity above 0.8). A name that merely
   * scores lower is held (Lynch: "don't pull the flowers and water the weeds").
   */
  sellPolicy?: "any-avoid" | "hard-rules";
  /**
   * Lynch profit-taking: sell a holding in `categories` once its gain from the average entry price
   * reaches `gainPct`, then do not buy it back for `cooldownPeriods` rebalances (rotate instead).
   * Omit to never take profits (every run before 2026-09-17).
   */
  profitTake?: { gainPct: number; categories: string[]; cooldownPeriods: number };
  /**
   * How a NEW buy is sized. "equal" (default, every run before 2026-09-18): equity / intended
   * positions. "market-cap": equity x the name's market cap / total market cap of held names plus
   * buy candidates — SPY's weighting applied to our picks. Both are then clamped by the same
   * per-name and sector caps; a name with no market cap falls back to the equal-weight target.
   * "sector-neutral": each sector gets its market-cap share of the index universe at the clock, split
   * among held names and candidates in that sector by market cap. Sectors without a pick stay in the
   * cash sleeve (SPY under the default cash policy), so the book differs from SPY mainly by WHICH
   * names it holds inside each sector. Needs `sectorOf`; unclassified names form their own bucket.
   * Existing holdings are never resized, in any mode, so sector weights are matched only at entry.
   */
  sizing?: "equal" | "market-cap" | "sector-neutral";
  /** Risk guardrails (config/strategy.lynch.json risk_guardrails). Omit to use documented defaults. */
  risk?: {
    maxPositionPct?: number; // per-name cap, % of portfolio (default 10)
    minCashFloorPct?: number; // keep at least this % in cash (default 2)
    maxPositions?: number; // max concurrent open names (default 40)
    minPriceUsd?: number; // penny-stock exclusion floor (default 1)
    maxSectorPct?: number; // per-sector concentration cap, % of portfolio (default 30; needs deps.sectorOf)
    minAdvUsd?: number; // liquidity floor: min trailing avg daily $ volume (default 1,000,000; 0 disables)
  };
}

export interface BacktestMetrics {
  totalReturnPct: number;
  cagrPct: number;
  volatilityPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  calmar: number;
  winRatePct: number;
  turnoverPct: number;
  /**
   * Average share of equity held as CASH across mark-to-market clocks, in % (0-100). Cash earns
   * nothing in this simulator, so against a fully-invested benchmark a 30% average cash weight is a
   * structural drag of roughly 0.3 x the benchmark's excess return — worth ruling out before
   * blaming stock selection. 0 when there are no clocks.
   */
  avgCashPct: number;
  /** Average weight of the benchmark cash sleeve (cashPolicy "benchmark"), % of equity. */
  avgSleevePct?: number;
  /** Interest credited on idle cash over the run (cashPolicy "tbill"), % of initial capital. */
  cashInterestPct?: number;
  /**
   * Strategy return minus benchmark return, in points. NULL when the benchmark could not be
   * priced — never silently 0, which would read as "beat the market" on a data failure.
   */
  benchmarkRelativePct: number | null;
}

import type { DecisionRecord } from "@dipbuyer/shared";

export interface BacktestResult {
  params: BacktestParams;
  equityCurve: Array<{ ts: string; value: number }>;
  metrics: BacktestMetrics;
  /** One audit-ready record per non-abstain decision (hashable via @dipbuyer/chain). */
  decisionRecords: DecisionRecord[];
  /** Orders actually placed. Distinct from turnoverPct, which is notional-weighted. */
  orders: number;
  /**
   * Symbol-clocks skipped because the data source failed (not "not yet listed"). Non-zero means
   * part of the universe silently dropped out, so the metrics are not a valid result.
   */
  dataSourceFailures: number;
  /** Reproducibility stamp. */
  provenance: { dataSnapshotId: string; strategyConfigHash: string; codeCommit: string; seed: number };
}

export { runBacktest } from "./run.js";
export type { RunDeps } from "./run.js";
export { computeMetrics, maxDrawdownPct, periodReturns } from "./metrics.js";
