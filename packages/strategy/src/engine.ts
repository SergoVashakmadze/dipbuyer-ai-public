import { isDebtGateExempt, type Fundamentals, type LynchCategory, type Understandability, type Verdict } from "@dipbuyer/shared";
import { loadStrategyConfig, type StrategyConfig } from "./config.js";
import { classify } from "./classify.js";
import { buildChecklist, scoreFromChecklist, peg } from "./score.js";

export interface EvaluateInput {
  fundamentals: Fundamentals;
  understandability: Understandability;
  /** Override config (e.g. per-tenant within guardrails). Defaults to canonical file. */
  config?: StrategyConfig;
}

export interface EvaluateResult {
  symbol: string;
  category: LynchCategory;
  categoryReason: string;
  checklist: ReturnType<typeof buildChecklist>;
  convictionScore: number;
  verdict: Verdict;
  sellTriggers: string[];
  strategyConfigHash: string;
}

/**
 * The D/E hard-reject threshold, read from config rather than hardcoded — `reject_gt` is
 * `impl_default` (our number, not Lynch's), so it must be tunable from the one canonical file the
 * config-drift guard hashes. Falls back to the historical 0.8 if the key is absent.
 */
function dteRejectGt(config: StrategyConfig): number {
  const v = config.global_criteria?.debt_to_equity?.reject_gt;
  return typeof v === "number" && Number.isFinite(v) ? v : 0.8;
}

/**
 * The deterministic heart of DipBuyer AI. Pure function: fundamentals + understandability in,
 * verdict out. No network, no LLM, no wall clock. This is the FCA-auditable, unit-tested core;
 * the LLM may propose narrative & category hints but THIS governs the eligible verdict.
 */
export function evaluate(input: EvaluateInput): EvaluateResult {
  const { config, hash } = input.config
    ? { config: input.config, hash: "override" }
    : loadStrategyConfig();
  const f = input.fundamentals;

  // Hard gate 1: understandability ("invest in what you know").
  if (!input.understandability.passed) {
    return abstain(f.symbol, "stalwart", "not_understandable", hash);
  }

  const { category, reason } = classify(f, config);
  const checklist = buildChecklist(f, category, config);

  // Hard gate 2: reject D/E > reject_gt outright regardless of score.
  //
  // Negative equity is NOT "low debt" — it is usually buybacks (or real distress), and the ratio
  // carries no solvency information there. Excluded from the gate so it cannot pass silently;
  // the scored criterion treats it as unknown too. See the fidelity notes.
  //
  // SECTOR-SCOPED (F1). Lynch exempted financials explicitly — debt is a bank's raw material
  // (*One Up on Wall Street* ch.13); his biggest winner, Fannie Mae, ran >10:1 leverage, and
  // *Beating the Street* has a whole chapter on savings-and-loans. Utilities are levered by
  // regulation. A blanket ratio cutoff rejected 6/7 financials and 5/6 utilities measured live —
  // it was screening out whole sectors Lynch actively invested in. Exempt names are still scored
  // on every other criterion; only the outright reject is lifted, because D/E cannot express
  // solvency for them. Companies with no SIC are NOT exempt — see `isDebtGateExempt`.
  const dte = f.debtToEquity;
  const rejectGt = dteRejectGt(config);
  if (dte !== null && dte >= 0 && dte > rejectGt && !isDebtGateExempt(f.sicCode)) {
    return {
      symbol: f.symbol,
      category,
      categoryReason: reason,
      checklist,
      convictionScore: 0,
      verdict: "avoid",
      sellTriggers: sellTriggersFor(category),
      strategyConfigHash: hash,
    };
  }

  // Insufficient data abstains. Before 2026-09-16 an empty checklist scored 0 and so read as
  // "avoid" — XOM and V, with every input missing from SEC EDGAR, were published as negative
  // verdicts. Unknown is not bad; the record says why it abstained.
  const missing = insufficientData(category, checklist);
  if (missing) {
    return { ...abstain(f.symbol, category, `insufficient_data: ${missing}`, hash), checklist };
  }

  const convictionScore = scoreFromChecklist(checklist);
  const bands = config.scoring.verdict_bands;
  let verdict: Verdict;
  if (convictionScore >= bands.buy_gte) verdict = "buy";
  else if (convictionScore >= bands.hold_band[0]) verdict = "hold";
  else verdict = "avoid";

  // Earnings-based overvaluation → explicit sell signal.
  const p = peg(f);
  if (p !== null && p >= 2.0 && (category === "stalwart" || category === "fast_grower")) {
    verdict = "sell";
  }

  // Category exclusion (config-driven, empty by default): a category whose buys historically lagged
  // the market can be held but not newly bought. Verdict rule only; the checklist is unchanged.
  if (verdict === "buy" && (config.scoring.buy_excluded_categories ?? []).includes(category)) {
    verdict = "hold";
  }

  // Shrinking-earnings cap (config-driven, off by default): on the S&P 500 2016-2025, buys and holds
  // with negative trailing EPS growth were the worst growth bucket in BOTH halves (-4.9% / -5.3%
  // 12-month excess vs SPY). Lynch's slow-grower rule is the same idea: sell when earnings stall.
  if (verdict === "buy" && config.scoring.buy_block_negative_eps_growth && f.epsGrowthPct !== null && f.epsGrowthPct < 0) {
    verdict = "hold";
  }

  // Required-criterion cap (config-driven, off by default): a buy needs this criterion to have PASSED.
  // Unknown (n/a) does not qualify. Used to test insider buying as a buy FILTER rather than a weight.
  const required = config.scoring.buy_require_criterion;
  if (verdict === "buy" && required && !checklist.some((c) => c.name === required && c.result === "pass")) {
    verdict = "hold";
  }

  // Value-trap cap: a cheap name WITHOUT positive cash generation may not reach "buy" on the
  // strength of its other criteria. The value premium concentrates in profitable value;
  // cheap-without-profitability historically earns ~market despite the discount (Piotroski
  // 2000; Avantis/Wahal 1973-2023) — and for Lynch specifically, a "cheap" PEG on evaporating
  // cash flow is usually peak-cycle earnings, the exact mistake ch.9 warns against. Verdict
  // rule only — the score stays a pure checklist roll-up, and the failed criterion is visible
  // in the checklist, so the demotion is reconstructible (PROMPT.md §5.4).
  if (verdict === "buy" && checklist.some((c) => c.name === "value_trap_guard" && c.result === "fail")) {
    verdict = "hold";
  }

  return {
    symbol: f.symbol,
    category,
    categoryReason: reason,
    checklist,
    convictionScore,
    verdict,
    sellTriggers: sellTriggersFor(category),
    strategyConfigHash: hash,
  };
}

/**
 * The anchor each category's verdict cannot be formed without, or null when there is enough.
 * Deliberately minimal: only the valuation anchor plus "at least one weighted criterion".
 */
function insufficientData(category: LynchCategory, checklist: EvaluateResult["checklist"]): string | null {
  const scored = (name: string) => checklist.some((c) => c.name === name && c.result !== "na");
  if ((category === "stalwart" || category === "fast_grower") && !scored("PEG") && !scored("PEGY")) {
    return "no PEG — needs a positive P/E (price and positive EPS) and positive EPS growth";
  }
  if (category === "slow_grower" && !scored("dividend_yield")) {
    return "no dividend yield — slow growers are bought for the dividend";
  }
  if (!checklist.some((c) => c.result !== "na" && c.weight > 0)) {
    return "no weighted criterion could be evaluated";
  }
  return null;
}

function abstain(symbol: string, category: LynchCategory, reason: string, hash: string): EvaluateResult {
  return {
    symbol,
    category,
    categoryReason: reason,
    checklist: [],
    convictionScore: 0,
    verdict: "abstain",
    sellTriggers: [],
    strategyConfigHash: hash,
  };
}

export function sellTriggersFor(category: LynchCategory): string[] {
  switch (category) {
    case "stalwart":
      return ["gain >= 30-50%", "fundamental deterioration"];
    case "fast_grower":
      return ["PEG >= 2.0", "growth deceleration", "concept saturation"];
    case "cyclical":
      return ["inventories build", "commodities peak", "capacity added"];
    case "turnaround":
      return ["recovery complete", "thesis failed"];
    case "asset_play":
      return ["market recognises asset"];
    case "slow_grower":
      return ["dividend-cut risk", "lost yield advantage"];
  }
}
