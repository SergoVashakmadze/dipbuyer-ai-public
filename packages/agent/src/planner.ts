/**
 * Pure trade planner: given the agent's decisions and current holdings, decide what to buy and
 * what to sell. Deterministic and side-effect-free (testable); the API layer applies sizing,
 * risk checks and broker execution. This is the heart of "invest in undervalued, divest overvalued".
 */
export interface DecisionLite {
  symbol: string;
  verdict: "buy" | "hold" | "trim" | "sell" | "avoid" | "abstain";
  convictionScore: number;
}
export interface PositionLite {
  symbol: string;
  qty: number;
}
export interface TradePlan {
  buys: string[]; // ranked by conviction, highest first
  sells: string[]; // held names the engine now rates sell/avoid (or trim)
}

export function planTrades(decisions: DecisionLite[], positions: PositionLite[]): TradePlan {
  const held = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol));

  const buys = decisions
    .filter((d) => d.verdict === "buy" && !held.has(d.symbol))
    .sort((a, b) => b.convictionScore - a.convictionScore)
    .map((d) => d.symbol);

  const bySymbol = new Map(decisions.map((d) => [d.symbol, d]));
  const sells = positions
    .filter((p) => p.qty > 0)
    .filter((p) => {
      const d = bySymbol.get(p.symbol);
      return d != null && (d.verdict === "sell" || d.verdict === "avoid" || d.verdict === "trim");
    })
    .map((p) => p.symbol);

  return { buys, sells };
}
