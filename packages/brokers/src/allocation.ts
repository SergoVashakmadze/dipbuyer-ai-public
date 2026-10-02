/**
 * Core + satellite allocation (the product decided after research rounds 3-4, HANDOVER 2026-09-18).
 *
 * The Lynch picks showed no stock-selection skill over SPY that survived both halves of 2016-2025,
 * so the product holds an index CORE (SPY) and runs the strategy in a SATELLITE capped at a share
 * of equity. The satellite is sized as if it were the whole portfolio (its own name and sector caps),
 * so it is a scaled copy of the backtested strategy; everything else except the cash floor sits in
 * the core, which is also what the backtest does with unused cash (its SPY sleeve).
 *
 * Pure: the caller supplies the book and prices; nothing here talks to a broker.
 */

export interface AllocationPolicy {
  /** Index ETF held as the core. Never screened, never sold as a stock pick, exempt from the name cap. */
  coreSymbol: string;
  /** Share of total equity the Lynch picks may take, 0-100. 100 = picks only (pre-2026-09-18 behaviour). */
  satellitePct: number;
  /** Cash kept uninvested, % of total equity. */
  cashFloorPct: number;
  /** Do not trade the core unless it is off target by more than this % of equity (churn guard). */
  coreBandPct: number;
}

/** Defaults: 30% satellite (backtest v0.4.0: -0.30 pts/yr vs SPY at 2.0% tracking error). */
export const DEFAULT_ALLOCATION: AllocationPolicy = { coreSymbol: "SPY", satellitePct: 30, cashFloorPct: 2, coreBandPct: 1 };

/** Policy from config/strategy.lynch.json `portfolio_construction`, falling back to the defaults. */
export function allocationFromConfig(cfg: Record<string, unknown> | undefined, satellitePctOverride?: number): AllocationPolicy {
  const num = (k: string, d: number) => (cfg && Number.isFinite(Number(cfg[k])) ? Number(cfg[k]) : d);
  const satellitePct = satellitePctOverride ?? num("satellite_pct_default", DEFAULT_ALLOCATION.satellitePct);
  if (!(satellitePct >= 0 && satellitePct <= 100)) throw new Error(`satellitePct must be between 0 and 100, got ${satellitePct}`);
  return {
    coreSymbol: typeof cfg?.core_symbol === "string" && cfg.core_symbol ? cfg.core_symbol.toUpperCase() : DEFAULT_ALLOCATION.coreSymbol,
    satellitePct,
    cashFloorPct: num("cash_floor_pct", DEFAULT_ALLOCATION.cashFloorPct),
    coreBandPct: num("core_band_pct", DEFAULT_ALLOCATION.coreBandPct),
  };
}

/**
 * Cash the satellite may spend on NEW picks: its budget (satellitePct of total equity) minus what
 * the picks it keeps are already worth. Never negative — picks that grew past the budget are not
 * trimmed, matching the backtest, which never resizes a holding.
 */
export function satelliteCash(totalEquity: number, keptPicksValue: number, policy: AllocationPolicy): number {
  return Math.max(0, (totalEquity * policy.satellitePct) / 100 - keptPicksValue);
}

export interface CoreTrade {
  side: "buy" | "sell";
  qty: number;
  notional: number;
  /** Core value the trade aims for. */
  target: number;
}

/**
 * The core trade that leaves everything except the picks and the cash floor in the index:
 * target = equity - picks after this plan - cash floor. Null inside the churn band.
 */
export function planCore(input: {
  totalEquity: number;
  coreValue: number;
  /** Value of the picks after this plan's sells and buys. */
  picksValueAfter: number;
  price: number;
  policy: AllocationPolicy;
  wholeShares?: boolean;
}): CoreTrade | null {
  const { totalEquity, coreValue, picksValueAfter, price, policy } = input;
  if (!(price > 0) || !(totalEquity > 0)) return null;
  const target = Math.max(0, totalEquity - picksValueAfter - (totalEquity * policy.cashFloorPct) / 100);
  const diff = target - coreValue;
  if (Math.abs(diff) <= (totalEquity * policy.coreBandPct) / 100) return null;
  const round = (q: number) => (input.wholeShares ? Math.floor(q) : Math.floor(q * 1e4) / 1e4);
  const qty = round(Math.abs(diff) / price);
  if (qty <= 0) return null;
  return { side: diff > 0 ? "buy" : "sell", qty, notional: qty * price, target };
}
