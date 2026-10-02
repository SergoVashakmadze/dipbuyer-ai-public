/**
 * Pure portfolio valuation helpers (mark-to-market). Kept separate from broker I/O so they are
 * deterministic and unit-tested; used by the API for /portfolio and the risk engine.
 */
export interface BasicPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
}

export interface ValuedPosition extends BasicPosition {
  marketValue: number;
  unrealizedPl: number;
}

export function markPosition(p: BasicPosition, price: number): ValuedPosition {
  return {
    symbol: p.symbol,
    qty: p.qty,
    avgEntryPrice: p.avgEntryPrice,
    marketValue: p.qty * price,
    unrealizedPl: (price - p.avgEntryPrice) * p.qty,
  };
}

export function portfolioValue(cash: number, positions: Array<{ marketValue: number }>): number {
  return positions.reduce((acc, p) => acc + p.marketValue, cash);
}
