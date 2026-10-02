/**
 * Copy a model portfolio: the trades that bring a follower's account to the model's weights.
 *
 * The follower's OWN picks (the "self" sleeve from the ledger) are left alone: they are excluded from
 * the holdings the plan may trade and from the equity the model's weights apply to. So a follower with
 * $100k who bought $10k of stocks themselves copies the model with the other $90k.
 *
 * Pure: weights, holdings and prices are supplied by the caller.
 */

export interface CopyTrade {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  notional: number;
  /** Target and current share of the copied equity, for the explanation. */
  targetWeight: number;
  currentWeight: number;
}

export function planCopy(input: {
  /** Model weights of total model equity, per symbol (cash is the remainder). */
  weights: Record<string, number>;
  /** Follower positions, with the qty the follower bought themselves ("self") that must not be traded. */
  positions: Array<{ symbol: string; qty: number; selfQty?: number }>;
  cash: number;
  prices: Record<string, number>;
  /** Skip a trade smaller than this share of the copied equity (churn guard). Default 1%. */
  bandPct?: number;
  wholeShares?: boolean;
}): { equity: number; trades: CopyTrade[] } {
  const band = (input.bandPct ?? 1) / 100;
  const round = (q: number) => (input.wholeShares ? Math.floor(q) : Math.floor(q * 1e4) / 1e4);
  const copyable = new Map<string, number>();
  for (const p of input.positions) {
    const q = Math.max(0, p.qty - (p.selfQty ?? 0));
    if (q > 0) copyable.set(p.symbol, (copyable.get(p.symbol) ?? 0) + q);
  }
  let equity = input.cash;
  for (const [s, q] of copyable) equity += q * (input.prices[s] ?? 0);
  if (!(equity > 0)) return { equity: 0, trades: [] };

  const trades: CopyTrade[] = [];
  for (const symbol of new Set([...Object.keys(input.weights), ...copyable.keys()])) {
    const price = input.prices[symbol];
    if (!(price && price > 0)) continue; // unpriced: never guess
    const held = copyable.get(symbol) ?? 0;
    const target = (input.weights[symbol] ?? 0) * equity;
    const diff = target - held * price;
    if (Math.abs(diff) < band * equity) continue;
    const qty = diff < 0 ? Math.min(held, round(-diff / price)) : round(diff / price);
    if (!(qty > 0)) continue;
    trades.push({ symbol, side: diff < 0 ? "sell" : "buy", qty, price, notional: qty * price, targetWeight: input.weights[symbol] ?? 0, currentWeight: (held * price) / equity });
  }
  // Sells first so they fund the buys; then largest buys first.
  trades.sort((a, b) => (a.side === b.side ? b.notional - a.notional : a.side === "sell" ? -1 : 1));
  return { equity, trades };
}

/** A book's weights: position value / total equity (cash included in the denominator). */
export function weightsOf(positions: Array<{ symbol: string; qty: number }>, cash: number, prices: Record<string, number>): Record<string, number> {
  let equity = cash;
  for (const p of positions) equity += p.qty * (prices[p.symbol] ?? 0);
  const w: Record<string, number> = {};
  if (!(equity > 0)) return w;
  for (const p of positions) if (p.qty > 0 && prices[p.symbol]) w[p.symbol] = (p.qty * prices[p.symbol]!) / equity;
  return w;
}
