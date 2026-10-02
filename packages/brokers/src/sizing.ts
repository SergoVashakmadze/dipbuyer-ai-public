import { maxBuyNotional, sectorHeadroom } from "./risk.js";

/**
 * Buy sizing for the live agent, the SAME rule the backtest runs (packages/backtest/src/run.ts):
 * equal weight across the positions we intend to hold, capped at maxPositions, each buy clamped by
 * the per-name cap + cash floor (maxBuyNotional) and the sector concentration cap (sectorHeadroom).
 * Before 2026-09-17 the agent bought a fixed $1,000 of every name instead, so the live product did
 * not trade the strategy that was backtested.
 *
 * Pure: the caller supplies prices, sectors and the current book; nothing here talks to a broker.
 */
export interface SizingGuardrails {
  maxPositions: number;
  maxPositionPct: number;
  minCashFloorPct: number;
  maxSectorPct: number;
}

export interface BuyCandidate {
  symbol: string;
  price: number;
  convictionScore: number;
  sector: string | null;
}

export interface HeldPosition {
  symbol: string;
  value: number;
  sector: string | null;
}

export interface SizedBuy {
  symbol: string;
  price: number;
  qty: number;
  notional: number;
  /** Set when the buy was not sized (qty 0), in plain English. */
  skipReason?: string;
  /** Set when a limit, not the equal-weight target, decided the size. */
  limitedBy?: "position cap or cash floor" | "sector cap";
}

export interface SizingResult {
  equity: number;
  intendedPositions: number;
  equalWeight: number;
  buys: SizedBuy[];
}

export function sizeBuys(input: {
  candidates: BuyCandidate[];
  held: HeldPosition[];
  cash: number;
  guardrails: SizingGuardrails;
  /** Whole shares only (live brokers that reject fractional limit orders). Default fractional. */
  wholeShares?: boolean;
}): SizingResult {
  const g = input.guardrails;
  const positionValues: Record<string, number> = {};
  const sectors = new Map<string, string | null>();
  for (const h of input.held) {
    positionValues[h.symbol] = (positionValues[h.symbol] ?? 0) + h.value;
    sectors.set(h.symbol, h.sector);
  }
  const heldSymbols = new Set(input.held.filter((h) => h.value > 0).map((h) => h.symbol));
  const ranked = input.candidates
    .filter((c) => !heldSymbols.has(c.symbol))
    .sort((a, b) => b.convictionScore - a.convictionScore);
  for (const c of ranked) sectors.set(c.symbol, c.sector);
  const sectorOf = (s: string) => sectors.get(s) ?? null;

  let cash = input.cash;
  const equity = cash + Object.values(positionValues).reduce((a, b) => a + b, 0);
  const intendedPositions = Math.min(g.maxPositions, heldSymbols.size + ranked.length);
  const equalWeight = intendedPositions > 0 ? equity / intendedPositions : 0;

  const buys: SizedBuy[] = [];
  let open = heldSymbols.size;
  for (const c of ranked) {
    const skip = (skipReason: string) => buys.push({ symbol: c.symbol, price: c.price, qty: 0, notional: 0, skipReason });
    if (!(c.price > 0)) {
      skip("no current price");
      continue;
    }
    if (open >= g.maxPositions) {
      skip(`portfolio already holds the maximum ${g.maxPositions} positions`);
      continue;
    }
    const byName = maxBuyNotional({ symbol: c.symbol, cash, positionValues }, g);
    const bySector = sectorHeadroom({ sector: c.sector, cash, positionValues, sectorOf }, { maxSectorPct: g.maxSectorPct });
    const target = Math.min(equalWeight, byName, bySector);
    let qty = target / c.price;
    qty = input.wholeShares ? Math.floor(qty) : Math.floor(qty * 1e4) / 1e4;
    if (qty <= 0) {
      skip(
        bySector <= 0
          ? `${c.sector} sector already at the ${g.maxSectorPct}% cap`
          : byName <= 0
            ? `cash floor (${g.minCashFloorPct}%) or ${g.maxPositionPct}% position cap leaves no room`
            : input.wholeShares
              ? "target is less than one whole share"
              : "target size rounds to zero",
      );
      continue;
    }
    const notional = qty * c.price;
    const limitedBy = target < equalWeight ? (bySector < byName ? "sector cap" : "position cap or cash floor") : undefined;
    buys.push({ symbol: c.symbol, price: c.price, qty, notional, ...(limitedBy ? { limitedBy } : {}) });
    cash -= notional;
    positionValues[c.symbol] = (positionValues[c.symbol] ?? 0) + notional;
    open++;
  }
  return { equity, intendedPositions, equalWeight, buys };
}

/** Guardrails from config/strategy.lynch.json risk_guardrails, with the backtest's defaults. */
export function guardrailsFromConfig(g: Record<string, number | string>): SizingGuardrails {
  const num = (k: string, d: number) => (Number.isFinite(Number(g[k])) ? Number(g[k]) : d);
  return {
    maxPositions: num("max_positions", 40),
    maxPositionPct: num("max_position_pct_of_portfolio", 10),
    minCashFloorPct: num("min_cash_floor_pct", 2),
    maxSectorPct: num("max_sector_pct_of_portfolio", 30),
  };
}
