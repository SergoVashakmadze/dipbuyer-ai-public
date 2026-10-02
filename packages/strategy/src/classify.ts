import { isCyclicalSic, type Fundamentals, type LynchCategory } from "@dipbuyer/shared";
import type { StrategyConfig } from "./config.js";

/**
 * Deterministic Lynch category classifier. Returns exactly one primary category.
 * Order matters: distress and asset-play checks precede growth-based bucketing so a
 * cyclical/asset-play/turnaround is never mislabelled as a generic growth stock.
 * (See the research notes)
 */
export function classify(f: Fundamentals, config: StrategyConfig): { category: LynchCategory; reason: string } {
  // Growth bands come from the config's category `id` blocks (single source of truth). Until
  // v0.4.1 they were hard-coded here and the config's stalwart band (10-20%) did not match them.
  const slowId = config.categories.slow_grower?.id as { eps_growth_pct?: { lte?: number }; min_market_cap_usd?: number; min_payout_ratio?: number } | undefined;
  const fastId = config.categories.fast_grower?.id as { eps_growth_pct?: { gte?: number } } | undefined;
  const slowMax = slowId?.eps_growth_pct?.lte ?? 5;
  const fastMin = fastId?.eps_growth_pct?.gte ?? 20;
  const slowMinCap = slowId?.min_market_cap_usd ?? 10_000_000_000;
  const slowMinPayout = slowId?.min_payout_ratio ?? 0.4;

  if (f.distressed === true) {
    return { category: "turnaround", reason: "Distressed → recovery candidate" };
  }
  if (f.hiddenAssetValueToMarketCap !== null && f.hiddenAssetValueToMarketCap >= 1.5) {
    return { category: "asset_play", reason: "Hidden asset value >> market cap" };
  }
  if (f.earningsCyclicality === "high") {
    return { category: "cyclical", reason: "Earnings swing with macro cycle" };
  }
  // Sources without a cyclicality signal (SEC EDGAR) fall back to the filer's industry. An
  // explicit "low"/"moderate" from a richer source still wins.
  if ((f.earningsCyclicality === null || f.earningsCyclicality === undefined) && isCyclicalSic(f.sicCode)) {
    return { category: "cyclical", reason: `Cyclical industry (SIC ${f.sicCode})` };
  }

  const g = f.epsGrowthPct;
  if (g === null) {
    // No reliable growth → treat as stalwart-style only if large & paying; else slow grower.
    if ((f.marketCapUsd ?? 0) >= slowMinCap && (f.payoutRatio ?? 0) >= slowMinPayout) {
      return { category: "slow_grower", reason: "Large, high-payout, growth unknown" };
    }
    return { category: "stalwart", reason: "Growth unknown; defaulting to stalwart screen" };
  }

  // Rounded for display: the raw CAGR (7.385091507318342) was printed verbatim into every rationale.
  const shown = g.toFixed(1);
  if (g <= slowMax) return { category: "slow_grower", reason: `EPS growth ${shown}% ≤ ${slowMax}%` };
  if (g < fastMin) return { category: "stalwart", reason: `EPS growth ${shown}% in the ${slowMax}–${fastMin}% band` };
  return { category: "fast_grower", reason: `EPS growth ${shown}% ≥ ${fastMin}%` };
}
