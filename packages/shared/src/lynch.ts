/**
 * Peter Lynch domain enums & types shared across the strategy engine, backtester and API.
 * Thresholds live in config/strategy.lynch.json — these are the SHAPES, not the numbers.
 */

export const LYNCH_CATEGORIES = [
  "slow_grower",
  "stalwart",
  "fast_grower",
  "cyclical",
  "turnaround",
  "asset_play",
] as const;

export type LynchCategory = (typeof LYNCH_CATEGORIES)[number];

export type Verdict = "buy" | "hold" | "trim" | "sell" | "avoid" | "abstain";

export type CriterionResult = "pass" | "fail" | "na";

export interface Criterion {
  name: string;
  /** Observed value (number, string, or null when unavailable). */
  value: number | string | null;
  /** Human-readable threshold expression, e.g. "<=1.0". */
  threshold: string;
  result: CriterionResult;
  /** Contribution weight in the conviction roll-up (0..1). */
  weight: number;
  /** Optional reason, esp. for `na`. */
  note?: string;
}

/** Point-in-time fundamentals required by the Lynch engine. Every field carries provenance separately. */
export interface Fundamentals {
  symbol: string;
  asOf: string; // ISO-8601 — must be <= simulated clock in backtest
  peRatio: number | null;
  epsGrowthPct: number | null; // whole-number percent
  epsGrowthHistoryPct: number[]; // trailing years, oldest→newest
  dividendYieldPct: number | null;
  payoutRatio: number | null;
  debtToEquity: number | null;
  netCashPerShare: number | null;
  roePct: number | null;
  currentRatio: number | null;
  freeCashFlow: number | null;
  revenueGrowthPct: number | null;
  inventoryGrowthPct: number | null;
  marketCapUsd: number | null;
  salesUsd: number | null;
  institutionalOwnershipPct: number | null;
  institutionalOwnershipMedianPct: number | null;
  insiderNetBuying: boolean | null;
  fiveYearAvgPe: number | null;
  earningsCyclicality: "low" | "moderate" | "high" | null;
  distressed: boolean | null;
  hiddenAssetValueToMarketCap: number | null;
  /**
   * SEC Standard Industrial Classification code, as self-reported by the filer.
   * Optional because only the EDGAR adapter can supply it. `null` = source had none;
   * `undefined` = source does not carry SIC at all. Both mean "unclassified" downstream —
   * see `sectorForSic` / `isDebtGateExempt`.
   */
  sicCode?: string | null;
  /**
   * Piotroski (2000) F_SCORE from the latest two fiscal years (see piotroski.ts). Optional: only the
   * EDGAR adapter computes it; `undefined` = source cannot, `null` = too little history.
   */
  piotroski?: import("./piotroski.js").PiotroskiScore | null;
  /**
   * Earnings yield on enterprise value: operating income (EBIT) / (market cap + total debt − cash
   * − short-term investments), anchor fiscal year. Optional: only the EDGAR adapter computes it;
   * `null` = no OperatingIncomeLoss tag, no price, or EV ≤ 0.
   */
  ebitToEv?: number | null;
  /**
   * Split-adjusted price change over the 12 months to the clock, percent. Optional: only computed
   * when the adapter is given a price-history source; `null` = no price a year back.
   */
  priceChange12mPct?: number | null;
  /** Latest annual EPS vs the prior fiscal year, percent (undefined for a non-positive base). */
  epsChangePct?: number | null;
  /**
   * Form 4 filings reporting an open-market purchase by an officer or director, filed in the 180
   * days before the clock. Optional: only set when the adapter is given an insider index
   * (apps/api/scripts/build-insider-index.mjs); 0 there means none, not unknown.
   */
  insiderPurchases180d?: number | null;
}

/** Qualitative gate output (LLM-assisted, deterministically checked). */
export interface Understandability {
  passed: boolean;
  businessSummary: string;
  growthStory: string;
}
