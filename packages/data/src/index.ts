import type { Fundamentals } from "@dipbuyer/shared";

/**
 * Data adapter contracts. Every returned field must carry source + asOf provenance for the
 * DecisionRecord. Implementations: alpaca (prices/news/corporate actions), polygon/massive (research
 * price history for backtests), financialdatasets
 * (fundamentals — Alpaca has NONE), fred (macro). Point-in-time discipline is mandatory for backtest.
 */
export interface PriceBar {
  symbol: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

export interface MarketDataAdapter {
  /** Historical bars; in backtest, must not return any bar with ts > asOf. */
  getBars(symbol: string, from: string, to: string, timeframe: string): Promise<PriceBar[]>;
  getLatestPrice(symbol: string, asOf?: string): Promise<number>;
}

export interface FundamentalsAdapter {
  /**
   * Stable identifier for where this data came from, e.g. "financialdatasets.ai" or
   * "in-memory-demo". Recorded in DecisionRecord.dataProvenance and surfaced in signed
   * proofs, so a consumer can always tell real data from a demo fixture. Adapters backed
   * by synthetic data MUST advertise that — a decision derived from fixtures is not a
   * claim about a real company.
   */
  readonly sourceId: string;
  /** Returns the latest fundamentals snapshot with asOf <= the given clock. */
  getFundamentals(symbol: string, asOf?: string): Promise<Fundamentals>;
}

/** Source ids that do NOT represent real market data. */
export const SYNTHETIC_SOURCE_IDS: readonly string[] = ["in-memory-demo", "backtest-synthetic", "demo-market-data"];

/** True when a decision built on this source must not be presented as real analysis. */
export function isSyntheticSource(sourceId: string): boolean {
  // "synthetic:<name>" marks any externally supplied synthetic dataset (e.g. an FCA Supercharged
  // Sandbox dataset loaded with loadFundamentalsDataset) without a code change per dataset.
  return SYNTHETIC_SOURCE_IDS.includes(sourceId) || sourceId.startsWith("synthetic:");
}

export { InMemoryFundamentals, InMemoryMarketData } from "./in-memory.js";
export { loadFundamentalsDataset, parseFundamentalsDataset } from "./dataset.js";
export { loadTbillRates, parseTbillCsv, tbillRateAt, defaultTbillCsvPath } from "./tbill.js";
export type { FundamentalsDataset } from "./dataset.js";
export { SecEdgarFundamentals } from "./sec-edgar.js";
export type { SecEdgarOptions } from "./sec-edgar.js";
export {
  FinancialDatasetsFundamentals,
  mapMetrics,
  dividendYieldPctFrom,
  inventoryGrowthPctFromBalances,
  netCashPerShareFromBalance,
  insiderNetBuyingFromTrades,
} from "./financialdatasets.js";
export type { FinancialDatasetsOptions } from "./financialdatasets.js";
export { AlpacaMarketData } from "./alpaca.js";
export type { AlpacaOptions } from "./alpaca.js";
export { PolygonMarketData, polygonTs } from "./polygon.js";
export type { PolygonOptions, PolygonAdjustment } from "./polygon.js";
export {
  withRetry,
  withCache,
  parseRetryAfter,
  MemoryFetchCache,
} from "./http.js";
export type { RetryOptions, CacheOptions, FetchCache } from "./http.js";
export {
  Sp500Membership,
  parseMembershipCsv,
  defaultMembershipCsvPath,
} from "./sp500-membership.js";
export type { MembershipInterval } from "./sp500-membership.js";
export { WindowCachedMarketData } from "./window-cached.js";
// TODO(phase-0): FredMacro adapter; cross-sectional institutional-ownership median (screening pass).
