import type { Fundamentals } from "@dipbuyer/shared";

/**
 * Research-page valuation and context: fair-value models, 52-week dip context and a
 * descriptive quality profile.
 *
 * NONE of this feeds the verdict. The verdict and conviction score come only from the
 * checklist in score.ts / engine.ts, which must stay reconstructible (PROMPT.md §5.4).
 * These numbers are evidence shown next to the verdict, the way a research terminal
 * would show them, and every one is derivable from Fundamentals plus daily closes.
 *
 * Percent inputs follow Fundamentals: whole-number percent (12 means 12%).
 */

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Lynch distrusted growth above ~25% as unsustainable; fair P/E is capped accordingly. */
export const LYNCH_GROWTH_CAP_PCT = 25;
/** Graham's formula was meant for moderate growth; it explodes on one-off spikes. */
export const GRAHAM_GROWTH_CAP_PCT = 15;
/** Graham's 1962 AAA corporate yield, the numerator constant of the revised formula. */
export const GRAHAM_BASE_YIELD_PCT = 4.4;
/** Current AAA corporate yield assumption. Shown on the page; update when yields move materially. */
export const DEFAULT_AAA_YIELD_PCT = 5.0;

/** Trailing EPS implied by price and P/E. Null for non-positive P/E (losses or missing). */
export function impliedEps(price: number | null, peRatio: number | null): number | null {
  if (!isNum(price) || !isNum(peRatio) || price <= 0 || peRatio <= 0) return null;
  return price / peRatio;
}

/**
 * Lynch's fair value ratio from One Up on Wall Street: (growth + dividend yield) / P/E.
 * Below 1 is poor, 1.5 is okay, 2 or more is what he looked for.
 */
export function lynchRatio(f: Pick<Fundamentals, "peRatio" | "epsGrowthPct" | "dividendYieldPct">): number | null {
  if (!isNum(f.peRatio) || !isNum(f.epsGrowthPct) || f.peRatio <= 0) return null;
  return (f.epsGrowthPct + Math.max(0, f.dividendYieldPct ?? 0)) / f.peRatio;
}

/** Price at which P/E equals growth + yield (the PEGY = 1 line), growth capped. */
export function lynchFairValue(eps: number | null, growthPct: number | null, yieldPct: number | null): number | null {
  if (!isNum(eps) || !isNum(growthPct) || eps <= 0 || growthPct <= 0) return null;
  return eps * (Math.min(growthPct, LYNCH_GROWTH_CAP_PCT) + Math.max(0, yieldPct ?? 0));
}

/** Graham revised formula: V = EPS × (8.5 + 2g) × 4.4 / Y. */
export function grahamValue(
  eps: number | null,
  growthPct: number | null,
  aaaYieldPct: number = DEFAULT_AAA_YIELD_PCT,
): number | null {
  if (!isNum(eps) || eps <= 0 || aaaYieldPct <= 0) return null;
  const g = isNum(growthPct) ? clamp(growthPct, 0, GRAHAM_GROWTH_CAP_PCT) : 0;
  return (eps * (8.5 + 2 * g) * GRAHAM_BASE_YIELD_PCT) / aaaYieldPct;
}

export interface Valuation {
  eps: number | null;
  lynchFairValue: number | null;
  grahamValue: number | null;
  /** Mean of the models that apply. */
  intrinsicValue: number | null;
  /** (intrinsic - price) / price as a fraction; positive means the price is below intrinsic value. */
  upside: number | null;
  lynchRatio: number | null;
  aaaYieldPct: number;
}

export function valuation(f: Fundamentals, price: number | null, aaaYieldPct = DEFAULT_AAA_YIELD_PCT): Valuation {
  const eps = impliedEps(price, f.peRatio);
  const lynch = lynchFairValue(eps, f.epsGrowthPct, f.dividendYieldPct);
  const graham = grahamValue(eps, f.epsGrowthPct, aaaYieldPct);
  const models = [lynch, graham].filter(isNum);
  const intrinsicValue = models.length ? models.reduce((a, b) => a + b, 0) / models.length : null;
  const upside = isNum(intrinsicValue) && isNum(price) && price > 0 ? (intrinsicValue - price) / price : null;
  return { eps, lynchFairValue: lynch, grahamValue: graham, intrinsicValue, upside, lynchRatio: lynchRatio(f), aaaYieldPct };
}

// ---------------------------------------------------------------------------
// Price context from daily closes.

export interface Close {
  ts: string;
  close: number;
}

export interface PriceContext {
  price: number;
  asOf: string;
  high52w: number;
  low52w: number;
  /** Fraction below the 52-week high (0.25 = 25% below). */
  drawdown: number;
  /** 0 at the 52-week low, 1 at the high. Null when high == low. */
  rangePosition: number | null;
  /** Simple returns as fractions over calendar lookbacks; null when history is too short. */
  returns: { "1M": number | null; "3M": number | null; "6M": number | null; YTD: number | null; "1Y": number | null };
}

const DAY_MS = 86_400_000;

/** Close on or before the given time, or null when history does not reach back that far. */
function closeAtOrBefore(bars: Close[], t: number): number | null {
  let found: number | null = null;
  for (const b of bars) {
    if (Date.parse(b.ts) <= t) found = b.close;
    else break;
  }
  return found;
}

/** Bars must be ascending by ts. Uses at most the trailing 365 days for the 52-week range. */
export function priceContext(bars: Close[]): PriceContext | null {
  const valid = bars.filter((b) => isNum(b.close) && b.close > 0 && !Number.isNaN(Date.parse(b.ts)));
  const last = valid.at(-1);
  if (!last) return null;
  const now = Date.parse(last.ts);
  const window = valid.filter((b) => Date.parse(b.ts) > now - 365 * DAY_MS);
  const high52w = Math.max(...window.map((b) => b.close));
  const low52w = Math.min(...window.map((b) => b.close));
  const first = Date.parse(valid[0]!.ts);
  const ret = (days: number) => {
    const t = now - days * DAY_MS;
    if (t < first) return null;
    const base = closeAtOrBefore(valid, t);
    return isNum(base) ? last.close / base - 1 : null;
  };
  const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1) - 1;
  const ytdBase = yearStart >= first ? closeAtOrBefore(valid, yearStart) : null;
  return {
    price: last.close,
    asOf: last.ts,
    high52w,
    low52w,
    drawdown: Math.max(0, (high52w - last.close) / high52w),
    rangePosition: high52w > low52w ? clamp((last.close - low52w) / (high52w - low52w), 0, 1) : null,
    returns: {
      "1M": ret(30),
      "3M": ret(91),
      "6M": ret(182),
      YTD: isNum(ytdBase) ? last.close / ytdBase - 1 : null,
      "1Y": ret(365),
    },
  };
}

// ---------------------------------------------------------------------------
// Quality profile: five 0-10 pillars, each the mean of whatever inputs exist.

/** Linear map of v from [bad, good] onto [0, 10], clamped. Works with bad > good. */
export function scale(v: number | null | undefined, bad: number, good: number): number | null {
  if (!isNum(v)) return null;
  return clamp(((v - bad) / (good - bad)) * 10, 0, 10);
}

const mean = (xs: Array<number | null>): number | null => {
  const present = xs.filter(isNum);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
};

export interface QualityProfile {
  overall: number | null;
  growth: number | null;
  profitability: number | null;
  health: number | null;
  capitalAllocation: number | null;
  momentum: number | null;
}

export function qualityProfile(f: Fundamentals, price: PriceContext | null): QualityProfile {
  const history = f.epsGrowthHistoryPct ?? [];
  const consistency = history.length ? (history.filter((x) => x > 0).length / history.length) * 10 : null;
  const growth = mean([scale(f.epsGrowthPct, -5, 25), scale(f.revenueGrowthPct, -5, 20), consistency]);
  const profitability = mean([
    scale(f.roePct, 0, 25),
    isNum(f.freeCashFlow) ? (f.freeCashFlow > 0 ? 10 : 0) : null,
  ]);
  const health = mean([
    // Negative equity makes D/E meaningless (same rule as score.ts): unknown, not pristine.
    isNum(f.debtToEquity) && f.debtToEquity >= 0 ? scale(f.debtToEquity, 2, 0) : null,
    scale(f.currentRatio, 0.5, 2),
    isNum(f.netCashPerShare) ? (f.netCashPerShare > 0 ? 10 : 3) : null,
    f.distressed === true ? 0 : null,
  ]);
  const capitalAllocation = mean([
    // Payout ratio is a fraction here. Zero is neutral; above ~90% of earnings is not sustainable.
    isNum(f.payoutRatio) && f.payoutRatio > 0 ? scale(f.payoutRatio, 1.2, 0.4) : null,
    f.insiderNetBuying === null || f.insiderNetBuying === undefined ? null : f.insiderNetBuying ? 10 : 3,
    scale(f.roePct, 0, 20),
  ]);
  const momentum = price
    ? mean([scale(price.returns["3M"], -0.2, 0.2), scale(price.returns["6M"], -0.3, 0.3), scale(price.returns["1Y"], -0.4, 0.4)])
    : null;
  // Momentum weighs least: a dip buyer deliberately looks at quality the market is selling.
  const weighted: Array<[number | null, number]> = [
    [growth, 0.25],
    [profitability, 0.25],
    [health, 0.2],
    [capitalAllocation, 0.2],
    [momentum, 0.1],
  ];
  const present = weighted.filter((w): w is [number, number] => isNum(w[0]));
  const weightSum = present.reduce((a, [, w]) => a + w, 0);
  const overall = present.length >= 3 ? present.reduce((a, [s, w]) => a + s * w, 0) / weightSum : null;
  return { overall, growth, profitability, health, capitalAllocation, momentum };
}
