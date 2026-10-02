/**
 * Piotroski (2000) F_SCORE, "Value Investing: The Use of Historical Financial Statement Information
 * to Separate Winners from Losers", Journal of Accounting Research 38, doi:10.2307/2672906.
 * Signal definitions follow research-notes/piotroski-2000/p01-14-notes-part2.md.
 *
 * Nine binary signals, 1 = good. Each is null when its inputs are missing, and the score is only
 * meaningful when enough are computable (the engine requires 7 of 9).
 *
 * Deviations from the paper, forced by SEC XBRL data and stated here rather than hidden:
 *  - ROA uses net income (NetIncomeLoss), not "before extraordinary items" (rarely tagged since 2015).
 *  - EQ_OFFER uses the diluted share count: issuance = more than 2% growth (the paper uses the
 *    equity-issuance flag, not available consistently). Share-count jumps that match a stock split
 *    are not issuance.
 *  - ΔLEVER: zero long-term debt in both years counts as "did not rise" (good).
 */

export interface PiotroskiYear {
  netIncome: number | null;
  cfo: number | null;
  /** Total assets at this fiscal year end. */
  assets: number | null;
  longTermDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  sharesDiluted: number | null;
  revenue: number | null;
  grossProfit: number | null;
}

export type PiotroskiSignal = "roa" | "cfo" | "deltaRoa" | "accrual" | "deltaLever" | "deltaLiquid" | "eqOffer" | "deltaMargin" | "deltaTurn";

export interface PiotroskiScore {
  score: number;
  computable: number;
  signals: Record<PiotroskiSignal, 0 | 1 | null>;
}

const SPLIT_FACTORS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50];
const ok = (...xs: Array<number | null>): boolean => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const bit = (cond: boolean | null): 0 | 1 | null => (cond === null ? null : cond ? 1 : 0);
const div = (a: number | null, b: number | null): number | null => (ok(a, b) && b! > 0 ? a! / b! : null);

/**
 * @param t   latest fiscal year
 * @param t1  the year before
 * @param t2  two years before (only its total assets: beginning-of-year assets for t1's ratios)
 */
export function piotroskiFScore(t: PiotroskiYear, t1: PiotroskiYear, t2: Pick<PiotroskiYear, "assets">): PiotroskiScore {
  const roa = div(t.netIncome, t1.assets);
  const roaPrev = div(t1.netIncome, t2.assets);
  const cfo = div(t.cfo, t1.assets);
  const avgAssets = ok(t.assets, t1.assets) ? (t.assets! + t1.assets!) / 2 : null;
  const avgAssetsPrev = ok(t1.assets, t2.assets) ? (t1.assets! + t2.assets!) / 2 : null;
  const lev = div(t.longTermDebt, avgAssets);
  const levPrev = div(t1.longTermDebt, avgAssetsPrev);
  const cr = div(t.currentAssets, t.currentLiabilities);
  const crPrev = div(t1.currentAssets, t1.currentLiabilities);
  const margin = div(t.grossProfit, t.revenue);
  const marginPrev = div(t1.grossProfit, t1.revenue);
  const turn = div(t.revenue, t1.assets);
  const turnPrev = div(t1.revenue, t2.assets);

  let eqOffer: boolean | null = null;
  if (ok(t.sharesDiluted, t1.sharesDiluted) && t1.sharesDiluted! > 0) {
    const r = t.sharesDiluted! / t1.sharesDiluted!;
    const isSplit = SPLIT_FACTORS.some((k) => Math.abs(r / k - 1) <= 0.06 || Math.abs(r * k - 1) <= 0.06);
    eqOffer = isSplit || r <= 1.02;
  }

  const signals: PiotroskiScore["signals"] = {
    roa: bit(roa === null ? null : roa > 0),
    cfo: bit(cfo === null ? null : cfo > 0),
    deltaRoa: bit(roa === null || roaPrev === null ? null : roa > roaPrev),
    accrual: bit(cfo === null || roa === null ? null : cfo > roa),
    deltaLever:
      lev === null || levPrev === null ? null : bit(t.longTermDebt === 0 && t1.longTermDebt === 0 ? true : lev < levPrev),
    deltaLiquid: bit(cr === null || crPrev === null ? null : cr > crPrev),
    eqOffer: bit(eqOffer),
    deltaMargin: bit(margin === null || marginPrev === null ? null : margin > marginPrev),
    deltaTurn: bit(turn === null || turnPrev === null ? null : turn > turnPrev),
  };
  const values = Object.values(signals);
  return {
    score: values.reduce<number>((a, v) => a + (v ?? 0), 0),
    computable: values.filter((v) => v !== null).length,
    signals,
  };
}
