/**
 * Pure pre-trade risk engine. Deterministic, side-effect-free, exhaustively testable — the
 * money-safety gate that runs before any order reaches a broker (the engineering design notes). Thresholds come from
 * config/strategy.lynch.json risk_guardrails; the caller supplies live portfolio state.
 */
export interface RiskParams {
  maxPositionPct: number;
  minCashFloorPct: number;
}

export interface RiskContext {
  side: "buy" | "sell";
  symbol: string;
  notional: number; // qty * fill price
  cash: number;
  /** Current market value per held symbol. */
  positionValues: Record<string, number>;
}

export interface RiskVerdict {
  ok: boolean;
  reason?: string;
}

export function checkRisk(ctx: RiskContext, p: RiskParams): RiskVerdict {
  if (ctx.side !== "buy") return { ok: true }; // sells aren't capped here
  const portfolioValue = ctx.cash + Object.values(ctx.positionValues).reduce((a, b) => a + b, 0);
  if (portfolioValue <= 0) return { ok: true };

  const existing = ctx.positionValues[ctx.symbol] ?? 0;
  if (((existing + ctx.notional) / portfolioValue) * 100 > p.maxPositionPct) {
    return { ok: false, reason: `Position cap breached: max ${p.maxPositionPct}% of portfolio per name` };
  }
  if (ctx.cash - ctx.notional < (p.minCashFloorPct / 100) * portfolioValue) {
    return { ok: false, reason: `Cash floor breached: keep at least ${p.minCashFloorPct}% in cash` };
  }
  return { ok: true };
}

/**
 * Largest buy notional for `symbol` that keeps BOTH the per-name position cap and the cash floor
 * satisfied. Returns 0 when no buy is permissible. Derived from the same inequalities as checkRisk,
 * so position sizing and the pre-trade gate never disagree (any notional in [0, max] passes checkRisk).
 */
export function maxBuyNotional(
  ctx: { symbol: string; cash: number; positionValues: Record<string, number> },
  p: RiskParams,
): number {
  const portfolioValue = ctx.cash + Object.values(ctx.positionValues).reduce((a, b) => a + b, 0);
  if (portfolioValue <= 0) return 0;
  const existing = ctx.positionValues[ctx.symbol] ?? 0;
  const byPositionCap = (p.maxPositionPct / 100) * portfolioValue - existing;
  const byCashFloor = ctx.cash - (p.minCashFloorPct / 100) * portfolioValue;
  return Math.max(0, Math.min(byPositionCap, byCashFloor));
}

export interface SectorRiskParams {
  maxSectorPct: number;
}

/**
 * Remaining buy notional for a sector under the concentration cap (config max_sector_pct_of_portfolio).
 * Sums current exposure of every held name in the same sector and returns the headroom to
 * maxSectorPct% of portfolio value. An unknown sector (null) is NOT capped — returns Infinity so an
 * unclassified name only faces the per-name + cash-floor limits.
 */
export function sectorHeadroom(
  ctx: {
    sector: string | null;
    cash: number;
    positionValues: Record<string, number>;
    sectorOf: (symbol: string) => string | null;
  },
  p: SectorRiskParams,
): number {
  if (ctx.sector === null) return Infinity;
  const portfolioValue = ctx.cash + Object.values(ctx.positionValues).reduce((a, b) => a + b, 0);
  if (portfolioValue <= 0) return 0;
  let sectorValue = 0;
  for (const [sym, val] of Object.entries(ctx.positionValues)) {
    if (ctx.sectorOf(sym) === ctx.sector) sectorValue += val;
  }
  return Math.max(0, (p.maxSectorPct / 100) * portfolioValue - sectorValue);
}
