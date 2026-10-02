import type { BacktestMetrics } from "./index.js";

/** Periodic simple returns from an equity series. */
export function periodReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    const cur = equity[i]!;
    out.push(prev === 0 ? 0 : (cur - prev) / prev);
  }
  return out;
}

export function maxDrawdownPct(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd * 100;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Sharpe/Sortino are per-period (not annualised) for simplicity; annualise in reporting. */
export function computeMetrics(
  equity: number[],
  opts: { periodsPerYear: number; riskFreePerPeriod?: number; benchmarkReturnPct?: number },
): BacktestMetrics {
  const rets = periodReturns(equity);
  const rf = opts.riskFreePerPeriod ?? 0;
  const excess = rets.map((r) => r - rf);
  const sd = stdev(rets);
  const downside = stdev(rets.filter((r) => r < 0));
  const start = equity[0] ?? 0;
  const end = equity.at(-1) ?? 0;
  const totalReturnPct = start === 0 ? 0 : ((end - start) / start) * 100;
  const years = rets.length / opts.periodsPerYear;
  const cagrPct = start <= 0 || years <= 0 ? 0 : ((end / start) ** (1 / years) - 1) * 100;
  const sharpe = sd === 0 ? 0 : (mean(excess) / sd) * Math.sqrt(opts.periodsPerYear);
  const sortino = downside === 0 ? 0 : (mean(excess) / downside) * Math.sqrt(opts.periodsPerYear);
  const mdd = maxDrawdownPct(equity);
  return {
    totalReturnPct,
    cagrPct,
    volatilityPct: sd * Math.sqrt(opts.periodsPerYear) * 100,
    sharpe,
    sortino,
    maxDrawdownPct: mdd,
    calmar: mdd === 0 ? 0 : cagrPct / mdd,
    winRatePct: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : 0,
    turnoverPct: 0, // set by the run loop
    avgCashPct: 0, // set by the run loop
    /**
     * NULL when no benchmark return was available — NOT `totalReturnPct - 0`.
     *
     * The `?? 0` this replaces silently compared the strategy against a 0% benchmark whenever
     * benchmark pricing failed, so a total data failure rendered as "beat the market". Observed
     * live: an unpriceable benchmark symbol made a run that trailed the S&P by 71 points report
     * +10.30 relative. A missing comparison must read as missing.
     */
    benchmarkRelativePct:
      opts.benchmarkReturnPct === undefined ? null : totalReturnPct - opts.benchmarkReturnPct,
  };
}
