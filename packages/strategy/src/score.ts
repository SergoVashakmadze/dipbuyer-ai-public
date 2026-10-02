import { isDebtGateExempt, type Criterion, type Fundamentals, type LynchCategory } from "@dipbuyer/shared";
import type { StrategyConfig } from "./config.js";

/**
 * Computes the criteria checklist for a company in its category. The conviction score
 * is a transparent weighted roll-up of these criteria and MUST be reconstructible from
 * the returned list (no opaque adjustments). See PROMPT.md §5.4.
 */

const PEG_BUY_LTE = 1.0;
const PEG_STRONG_LTE = 0.5;
const DTE_PREFER_LT = 0.33;
const DTE_REJECT_GT = 0.8;

/** PEG using the lower-is-better convention. Null when inputs unusable. */
export function peg(f: Fundamentals): number | null {
  if (f.peRatio === null || f.epsGrowthPct === null || f.epsGrowthPct <= 0) return null;
  return f.peRatio / f.epsGrowthPct;
}

/**
 * PEGY adds dividend yield to the denominator (lower-is-better). Undefined for non-positive
 * growth, like PEG: a yield must not turn shrinking earnings into a "cheap" ratio (NKE at
 * -2.8% growth and a 4.5% yield read PEGY 10 — a number with no meaning).
 */
export function pegy(f: Fundamentals): number | null {
  if (f.peRatio === null || f.epsGrowthPct === null || f.epsGrowthPct <= 0) return null;
  const denom = f.epsGrowthPct + (f.dividendYieldPct ?? 0);
  if (denom <= 0) return null;
  return f.peRatio / denom;
}

function crit(
  name: string,
  value: number | string | null,
  threshold: string,
  pass: boolean | null,
  weight: number,
  note?: string,
): Criterion {
  return { name, value: tidy(value), threshold, result: pass === null ? "na" : pass ? "pass" : "fail", weight, note };
}

/** Round displayed values (0.5342751429532459 -> 0.534). Integers, e.g. FCF in dollars, are kept exact. */
function tidy(v: number | string | null): number | string | null {
  return typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toFixed(3)) : v;
}

const one = (v: number) => Number(v.toFixed(1));

/**
 * Trailing EPS levels rebuilt from year-over-year growth (oldest = 1). Null when the series is
 * too short to say anything about the cycle.
 */
export function epsLevels(history: number[]): number[] | null {
  if (history.length < 3) return null;
  const levels = [1];
  for (const g of history) levels.push(levels[levels.length - 1]! * (1 + g / 100));
  return levels.every((x) => Number.isFinite(x) && x > 0) ? levels : null;
}

export function buildChecklist(
  f: Fundamentals,
  category: LynchCategory,
  config: StrategyConfig,
): Criterion[] {
  const weights = config.categories[category]?.weights ?? {};
  const w = (k: string) => weights[k] ?? 0;
  // Thresholds from global_criteria (single source of truth); the constants are fallbacks for a
  // config that omits them.
  const dteCfg = config.global_criteria?.debt_to_equity as { prefer_lt?: number; reject_gt?: number } | undefined;
  const pegCfg = config.global_criteria?.peg as { buy_lte?: number; strong_lte?: number } | undefined;
  const dtePreferLt = dteCfg?.prefer_lt ?? DTE_PREFER_LT;
  const dteRejectGt = dteCfg?.reject_gt ?? DTE_REJECT_GT;
  const pegBuyLte = pegCfg?.buy_lte ?? PEG_BUY_LTE;
  const pegStrongLte = pegCfg?.strong_lte ?? PEG_STRONG_LTE;
  const checklist: Criterion[] = [];

  // Valuation gate — earnings-based PEG is NA for cyclical/asset_play/turnaround.
  const earningsBased = category === "slow_grower" || category === "stalwart" || category === "fast_grower";
  if (earningsBased) {
    const useDividend = (f.dividendYieldPct ?? 0) > 0;
    const v = useDividend ? pegy(f) : peg(f);
    checklist.push(
      crit(
        useDividend ? "PEGY" : "PEG",
        v === null ? null : Number(v.toFixed(3)),
        `<=${pegBuyLte}`,
        v === null ? null : v <= pegBuyLte,
        w("peg"),
        v !== null && v <= pegStrongLte ? "strongly underpriced" : undefined,
      ),
    );

    // Strongly underpriced (config-driven, off by default): Lynch's PEG <= 0.5 "very positive" cell,
    // scored as its own criterion. Among PEG/PEGY <= 1 names, <= 0.5 beat 0.5-1.0 in both halves of
    // the 2016-2025 S&P 500 run (+7.96% / +1.63% 12-month excess vs SPY).
    const strong = config.global_criteria?.peg_strong as { enabled?: boolean; lte?: number } | undefined;
    if (strong?.enabled) {
      const lte = strong.lte ?? pegStrongLte;
      checklist.push(crit("peg_strong", v === null ? null : Number(v.toFixed(3)), `<=${lte}`, v === null ? null : v <= lte, w("peg_strong")));
    }

    // Value×profitability interaction. Cheapness only predicts returns when profitability
    // confirms it: high-B/M+high-profitability earned 16.3-19.4% CAGR 1973-2023 while
    // high-B/M+low-profitability matched the market (Avantis/Wahal, CRSP/Compustat) —
    // Piotroski (2000) is the same result inside the value bucket. So a PASSING PEG with
    // non-positive cash generation is the trap cell, not a bargain. Applies only to names
    // the valuation gate calls cheap; for everything else the interaction carries no
    // information and abstains. FCF is the confirmation axis (Piotroski's CFO>0) because
    // ROE is already scored separately and is meaningless under buyback-negative equity.
    const cheap = v !== null && v <= pegBuyLte;
    checklist.push(
      crit(
        "value_trap_guard",
        f.freeCashFlow,
        "cheap requires FCF>0",
        !cheap || f.freeCashFlow === null ? null : f.freeCashFlow > 0,
        w("value_trap_guard"),
        !cheap
          ? "not in the value cell — interaction n/a"
          : f.freeCashFlow === null
            ? "cash profitability unknown"
            : f.freeCashFlow > 0
              ? "profitable value — the premium cell"
              : "VALUE TRAP: cheap without cash profitability (Piotroski 2000)",
      ),
    );
  } else {
    checklist.push(crit("PEG", null, "n/a for category", null, 0, `earnings-based PEG not applicable to ${category}`));
  }

  // Balance sheet — universal but weighted per category, and NOT applicable to lenders/utilities.
  //
  // For a bank or a regulated utility, D/E measures the business model rather than prudence
  // (F1). Scoring them against `<0.33` would re-impose through the score the same blanket
  // rejection the hard gate just stopped applying, so the criterion is marked `na` — the same
  // treatment negative equity gets, and for the same reason: the ratio carries no information
  // here. These names are still scored on every other criterion.
  const dteExempt = isDebtGateExempt(f.sicCode);
  checklist.push(
    crit(
      "debt_to_equity",
      f.debtToEquity,
      `<${dtePreferLt}`,
      // NEGATIVE equity makes D/E meaningless, so treat it as UNKNOWN rather than a pass.
      // `debtToEquity < 0.33` scored buyback-driven negative equity as MAXIMALLY conservative:
      // MCD (-22.7), SBUX (-2.0), LOW (-4.0), ABBV (-19.7) all read as pristine balance sheets
      // while BAC at 1.05 was hard-rejected. The ratio was measuring buyback accounting, not risk.
      dteExempt || f.debtToEquity === null || f.debtToEquity < 0
        ? null
        : f.debtToEquity <= dteRejectGt && f.debtToEquity < dtePreferLt,
      w("debt_to_equity"),
      dteExempt
        ? "D/E not a solvency measure for financials/utilities (SIC-scoped)"
        : f.debtToEquity !== null && f.debtToEquity > dteRejectGt
          ? `REJECT: D/E > ${dteRejectGt}`
          : undefined,
    ),
  );

  // Inventory red flag (Lynch).
  if (f.inventoryGrowthPct !== null && f.revenueGrowthPct !== null) {
    const flagged = f.inventoryGrowthPct > f.revenueGrowthPct;
    checklist.push(
      crit("inventory_vs_sales", `${one(f.inventoryGrowthPct)}% vs ${one(f.revenueGrowthPct)}%`, "inv% <= rev%", !flagged, w("inventory_trend") || 0.05),
    );
  }

  // Growth consistency for earnings-based categories.
  if (earningsBased && f.epsGrowthHistoryPct.length > 0) {
    const positiveYears = f.epsGrowthHistoryPct.filter((x) => x > 0).length;
    const consistent = positiveYears >= Math.min(3, f.epsGrowthHistoryPct.length);
    checklist.push(crit("growth_consistency", `${positiveYears}/${f.epsGrowthHistoryPct.length} yrs +`, ">=3 yrs", consistent, w("growth_consistency") || w("growth_quality")));
  }

  // Lynch positives.
  if (f.roePct !== null) checklist.push(crit("roe", one(f.roePct), ">=15%", f.roePct >= 15, w("roe") || 0.05));
  if (f.freeCashFlow !== null) checklist.push(crit("fcf_positive", f.freeCashFlow, ">0", f.freeCashFlow > 0, w("fcf_positive") || 0.05));
  if (f.insiderNetBuying !== null) checklist.push(crit("insider_buying", f.insiderNetBuying ? "net buy" : "net sell", "net buy bullish", f.insiderNetBuying, w("insider_buying") || 0.05));
  if (f.institutionalOwnershipPct !== null && f.institutionalOwnershipMedianPct !== null) {
    checklist.push(crit("institutional_ownership", f.institutionalOwnershipPct, "< median (Street Lag)", f.institutionalOwnershipPct < f.institutionalOwnershipMedianPct, 0.05));
  }

  // Piotroski F_SCORE (value × profitability research, HANDOVER 2026-07-25). Only when the config
  // enables it, so canonical decisions are unchanged. Weight 0 = observe only: the criterion is
  // recorded for analysis but excluded from the score. Needs 7 of 9 signals computable.
  const pio = config.global_criteria?.piotroski as { enabled?: boolean; min_score?: number } | undefined;
  if (pio?.enabled) {
    const min = pio.min_score ?? 6;
    const fs = f.piotroski;
    checklist.push(
      crit(
        "f_score",
        fs ? fs.score : null,
        `>=${min} of 9`,
        !fs || fs.computable < 7 ? null : fs.score >= min,
        w("f_score"),
        !fs ? "F_SCORE unavailable from this source" : fs.computable < 7 ? `only ${fs.computable}/9 signals computable` : undefined,
      ),
    );
  }

  // EBIT/EV earnings yield (Step 2 conviction signals, HANDOVER 2026-09-17). Same gating as F_SCORE:
  // absent from canonical decisions, weight 0 = observe only. Financials abstain: EV is not a
  // meaningful price for a business whose debt is its inventory.
  const eey = config.global_criteria?.ebit_ev as { enabled?: boolean; min_ebit_ev?: number } | undefined;
  if (eey?.enabled) {
    const min = eey.min_ebit_ev ?? 0.08;
    const sic = Number(f.sicCode);
    const financial = f.sicCode != null && sic >= 6000 && sic <= 6799;
    const v = f.ebitToEv ?? null;
    checklist.push(
      crit(
        "ebit_ev",
        financial ? null : v,
        `>=${min * 100}%`,
        financial || v === null ? null : v >= min,
        w("ebit_ev"),
        financial ? "EBIT/EV not meaningful for financials" : v === null ? "EBIT/EV unavailable from this source" : undefined,
      ),
    );
  }

  // Individual Piotroski signals the literature singles out, recorded separately (observe-only):
  // no equity issuance (Lynch: buybacks; Piotroski EQ_OFFER), cash-backed earnings (accrual), and
  // margin AND turnover both improving (Piotroski 2000 table 8C, strong-weak +10.2%/yr).
  if ((config.global_criteria?.piotroski_signals as { enabled?: boolean } | undefined)?.enabled) {
    const sig = f.piotroski?.signals;
    const bit = (v: 0 | 1 | null | undefined) => (v === null || v === undefined ? null : v === 1);
    checklist.push(crit("no_share_issuance", sig?.eqOffer ?? null, "diluted shares not up", bit(sig?.eqOffer), w("no_share_issuance")));
    checklist.push(crit("cash_backed_earnings", sig?.accrual ?? null, "CFO > net income", bit(sig?.accrual), w("cash_backed_earnings")));
    const dm = bit(sig?.deltaMargin), dt = bit(sig?.deltaTurn);
    checklist.push(
      crit("margin_and_turnover_up", dm === null || dt === null ? null : Number(dm) + Number(dt), "both improving", dm === null || dt === null ? null : dm && dt, w("margin_and_turnover_up")),
    );
  }

  // Price-history criteria (observe-only unless weighted). Lynch's price/earnings matrix: earnings up
  // while the price fell is the buy cell — the Lynch form of a dip, as opposed to a price drop alone.
  // P/E against the stock's own history is his main valuation check for stalwarts. 12-month price
  // change doubles as a falling-knife guard.
  const gc = config.global_criteria ?? {};
  if ((gc.earnings_up_price_down as { enabled?: boolean } | undefined)?.enabled) {
    const p = f.priceChange12mPct ?? null, e = f.epsChangePct ?? null;
    checklist.push(
      crit("earnings_up_price_down", p, "EPS up, 12m price down", p === null || e === null ? null : e > 0 && p < 0, w("earnings_up_price_down"),
        e === null ? "no comparable prior-year EPS" : p === null ? "no price a year back" : undefined),
    );
  }
  // Lynch: insiders buying their own stock on the open market is the one insider signal that means
  // something (selling is noise). Officer/director Form 4 code-P purchases in the last 180 days.
  if ((gc.insider_open_market_buy as { enabled?: boolean } | undefined)?.enabled) {
    const n = f.insiderPurchases180d ?? null;
    checklist.push(crit("insider_open_market_buy", n, ">=1 officer/director purchase in 180d", n === null ? null : n >= 1, w("insider_open_market_buy"),
      n === null ? "no insider index loaded" : undefined));
  }
  if ((gc.momentum_12m as { enabled?: boolean } | undefined)?.enabled) {
    const p = f.priceChange12mPct ?? null;
    checklist.push(crit("momentum_12m", p, ">0% over 12m", p === null ? null : p > 0, w("momentum_12m")));
  }
  if ((gc.pe_vs_own_history as { enabled?: boolean } | undefined)?.enabled) {
    const rel = f.peRatio !== null && f.fiveYearAvgPe !== null && f.fiveYearAvgPe > 0 ? f.peRatio / f.fiveYearAvgPe : null;
    checklist.push(
      crit("pe_vs_own_history", rel, "P/E <= own trailing avg", rel === null ? null : rel <= 1, w("pe_vs_own_history"),
        rel === null ? "needs a positive P/E and 3+ years of positive EPS with prices" : undefined),
    );
  }

  // Screen thresholds from popular Lynch screeners (P/E < 25, 5y EPS growth 15-30%), observe-only
  // like ebit_ev: absent from canonical decisions, weight 0 unless an experiment config weights them.
  const peCap = config.global_criteria?.pe_cap as { enabled?: boolean; max_pe?: number } | undefined;
  if (peCap?.enabled) {
    const max = peCap.max_pe ?? 25;
    checklist.push(
      crit("pe_cap", f.peRatio, `<${max}`, f.peRatio === null ? null : f.peRatio < max, w("pe_cap"), f.peRatio === null ? "no positive P/E" : undefined),
    );
  }
  const band = config.global_criteria?.eps_growth_band as { enabled?: boolean; min_pct?: number; max_pct?: number } | undefined;
  if (band?.enabled) {
    const lo = band.min_pct ?? 15;
    const hi = band.max_pct ?? 30;
    const g = f.epsGrowthPct;
    checklist.push(crit("eps_growth_band", g, `${lo}-${hi}%`, g === null ? null : g >= lo && g <= hi, w("eps_growth_band")));
  }

  // Category-specific anchors.
  if (category === "slow_grower" && f.dividendYieldPct !== null) {
    checklist.push(crit("dividend_yield", f.dividendYieldPct, ">=3%", f.dividendYieldPct >= 3, w("dividend_yield")));
  }

  // Dividend cover. Configured (slow_grower weight 0.25, min_payout_cover 1.5) but never computed
  // until 2026-09-16, so the weight was silently inert and a high yield alone could carry a
  // shrinking company to "buy" (NKE: 4.5% yield, cover 1.29x, conviction 71). Lynch buys slow
  // growers for the dividend, which only counts if earnings can keep paying it.
  if (w("dividend_cover") > 0 && f.payoutRatio !== null && (f.dividendYieldPct ?? 0) > 0) {
    const minCover = Number(config.categories[category]?.buy?.min_payout_cover ?? 1.5);
    const cover = f.payoutRatio > 0 ? 1 / f.payoutRatio : null;
    checklist.push(
      crit(
        "dividend_cover",
        cover,
        `>=${minCover}x earnings`,
        cover === null ? false : cover >= minCover,
        w("dividend_cover"),
        cover === null ? "dividend paid without positive earnings" : undefined,
      ),
    );
  }

  // Cycle position. Lynch buys cyclicals when earnings are DEPRESSED (P/E looks high) and sells
  // when they peak (P/E looks low). Latest EPS at or below its trailing average = lower half.
  if (category === "cyclical") {
    const levels = epsLevels(f.epsGrowthHistoryPct);
    const avg = levels ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
    const rel = levels && avg ? levels[levels.length - 1]! / avg : null;
    checklist.push(
      crit(
        "cycle_position",
        rel,
        "EPS <= trailing avg (trough side)",
        rel === null ? null : rel <= 1,
        w("cycle_position"),
        rel === null ? "EPS history too short or crosses zero" : rel <= 1 ? "earnings below cycle average" : "earnings above cycle average — late-cycle risk",
      ),
    );
  }
  if (category === "asset_play" && f.hiddenAssetValueToMarketCap !== null) {
    checklist.push(crit("asset_value_ratio", f.hiddenAssetValueToMarketCap, ">=1.5", f.hiddenAssetValueToMarketCap >= 1.5, w("asset_value_ratio")));
  }
  if ((category === "turnaround" || category === "asset_play") && f.netCashPerShare !== null) {
    checklist.push(crit("net_cash_floor", f.netCashPerShare, ">0", f.netCashPerShare > 0, w("net_cash") || w("net_cash_floor")));
  }

  return checklist;
}

/** Weighted 0..100 conviction. Pass=full weight, NA=excluded (renormalised), fail=0. */
export function scoreFromChecklist(checklist: Criterion[]): number {
  const scored = checklist.filter((c) => c.result !== "na" && c.weight > 0);
  const totalWeight = scored.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const earned = scored.reduce((s, c) => s + (c.result === "pass" ? c.weight : 0), 0);
  return Math.round((earned / totalWeight) * 100);
}
