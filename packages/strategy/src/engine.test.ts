import { describe, expect, it } from "vitest";
import type { Fundamentals, Understandability } from "@dipbuyer/shared";
import { evaluate } from "./engine.js";
import { loadStrategyConfig } from "./config.js";
import { peg, pegy } from "./score.js";

const ok: Understandability = { passed: true, businessSummary: "Sells widgets", growthStory: "More stores" };

function base(overrides: Partial<Fundamentals>): Fundamentals {
  return {
    symbol: "TEST",
    asOf: "2026-01-01T00:00:00Z",
    peRatio: 15,
    epsGrowthPct: 20,
    epsGrowthHistoryPct: [18, 19, 20, 21],
    dividendYieldPct: 0,
    payoutRatio: 0,
    debtToEquity: 0.2,
    netCashPerShare: 5,
    roePct: 18,
    currentRatio: 1.5,
    freeCashFlow: 1_000_000,
    revenueGrowthPct: 22,
    inventoryGrowthPct: 10,
    marketCapUsd: 2_000_000_000,
    salesUsd: 1_500_000_000,
    institutionalOwnershipPct: 30,
    institutionalOwnershipMedianPct: 50,
    insiderNetBuying: true,
    fiveYearAvgPe: 18,
    earningsCyclicality: "low",
    distressed: false,
    hiddenAssetValueToMarketCap: null,
    ...overrides,
  };
}

describe("PEG convention (lower is better)", () => {
  it("PE 6 / growth 12 = 0.5 (strong)", () => {
    expect(peg(base({ peRatio: 6, epsGrowthPct: 12 }))).toBeCloseTo(0.5, 3);
  });
  it("PEGY adds dividend yield to denominator", () => {
    // (growth 15 + yield 3) -> PE 6 / 18 = 0.333
    expect(pegy(base({ peRatio: 6, epsGrowthPct: 15, dividendYieldPct: 3 }))).toBeCloseTo(0.333, 2);
  });
});

describe("evaluate()", () => {
  it("classifies a 20%+ grower as fast_grower and buys a cheap one", () => {
    const r = evaluate({ fundamentals: base({ peRatio: 12, epsGrowthPct: 25 }), understandability: ok });
    expect(r.category).toBe("fast_grower");
    expect(["buy", "hold"]).toContain(r.verdict);
    expect(r.convictionScore).toBeGreaterThan(0);
  });

  it("rejects D/E > 0.8 outright", () => {
    const r = evaluate({ fundamentals: base({ debtToEquity: 1.2 }), understandability: ok });
    expect(r.verdict).toBe("avoid");
    expect(r.convictionScore).toBe(0);
  });

  it("still rejects a levered OPERATING company when the SIC is known", () => {
    // Scoping the gate must not weaken it outside the exempt sectors.
    const r = evaluate({ fundamentals: base({ debtToEquity: 1.2, sicCode: "3571" }), understandability: ok });
    expect(r.verdict).toBe("avoid");
    expect(r.convictionScore).toBe(0);
  });

  it("does NOT hard-reject a bank on D/E — debt is a bank's raw material (F1)", () => {
    // BAC at 1.05 was banned by a blanket cutoff that rejected 6/7 financials measured live.
    // Lynch exempted financials explicitly; Fannie Mae, his biggest winner, ran >10:1 leverage.
    const bank = evaluate({
      fundamentals: base({ debtToEquity: 1.05, sicCode: "6021" }), // national commercial banks
      understandability: ok,
    });
    expect(bank.verdict, "no blanket D/E reject for financials").not.toBe("avoid");
    // The ratio carries no solvency information here, so the criterion abstains rather than
    // failing — otherwise the score would re-impose the rejection the gate just stopped applying.
    const dte = bank.checklist.find((c) => c.name === "debt_to_equity");
    expect(dte?.result).toBe("na");
    expect(dte?.note).toMatch(/financials\/utilities/);
    // And it is still genuinely screened on everything else.
    expect(bank.convictionScore).toBeGreaterThan(0);
  });

  it("does NOT hard-reject a regulated utility on D/E (F1)", () => {
    const util = evaluate({
      fundamentals: base({ debtToEquity: 1.4, sicCode: "4911" }), // electric services
      understandability: ok,
    });
    expect(util.verdict).not.toBe("avoid");
  });

  it("applies the gate when the SIC is UNKNOWN — the exemption fails closed", () => {
    // Non-EDGAR sources carry no SIC. Exempting the unclassified would delete the gate, not scope
    // it, and every fixture in this suite would silently stop being screened.
    const r = evaluate({ fundamentals: base({ debtToEquity: 1.2, sicCode: null }), understandability: ok });
    expect(r.verdict).toBe("avoid");
  });

  it("reads the reject threshold from config rather than a hardcoded 0.8", () => {
    // `reject_gt` is impl_default (our number, not Lynch's), so it must be tunable from the one
    // canonical config file the drift guard hashes.
    const cfg = loadStrategyConfig().config;
    const loose = {
      ...cfg,
      global_criteria: { ...cfg.global_criteria, debt_to_equity: { ...cfg.global_criteria.debt_to_equity, reject_gt: 2.0 } },
    };
    const r = evaluate({ fundamentals: base({ debtToEquity: 1.2 }), understandability: ok, config: loose });
    expect(r.verdict).not.toBe("avoid");
  });

  it("issues a sell on PEG >= 2.0 for a fast grower", () => {
    const r = evaluate({ fundamentals: base({ peRatio: 60, epsGrowthPct: 25 }), understandability: ok });
    expect(r.verdict).toBe("sell");
  });

  it("does NOT apply earnings-based PEG to a cyclical", () => {
    const r = evaluate({ fundamentals: base({ earningsCyclicality: "high", peRatio: 40 }), understandability: ok });
    expect(r.category).toBe("cyclical");
    const pegCrit = r.checklist.find((c) => c.name === "PEG");
    expect(pegCrit?.result).toBe("na");
  });

  it("treats a distressed name as a turnaround", () => {
    const r = evaluate({ fundamentals: base({ distressed: true }), understandability: ok });
    expect(r.category).toBe("turnaround");
  });

  it("classifies a low-growth high-payout name as a slow_grower and scores its yield", () => {
    const r = evaluate({
      fundamentals: base({ epsGrowthPct: 3, dividendYieldPct: 4, payoutRatio: 0.6, marketCapUsd: 2e10 }),
      understandability: ok,
    });
    expect(r.category).toBe("slow_grower");
    expect(r.checklist.some((c) => c.name === "dividend_yield")).toBe(true);
  });

  it("classifies a 10-20% grower as a stalwart", () => {
    const r = evaluate({ fundamentals: base({ epsGrowthPct: 12 }), understandability: ok });
    expect(r.category).toBe("stalwart");
  });

  it("classifies a hidden-asset name as an asset_play and skips earnings PEG", () => {
    const r = evaluate({ fundamentals: base({ hiddenAssetValueToMarketCap: 2.0 }), understandability: ok });
    expect(r.category).toBe("asset_play");
    expect(r.checklist.find((c) => c.name === "PEG")?.result).toBe("na");
    expect(r.checklist.some((c) => c.name === "asset_value_ratio")).toBe(true);
  });

  it("abstains when not understandable", () => {
    const r = evaluate({
      fundamentals: base({}),
      understandability: { passed: false, businessSummary: "", growthStory: "" },
    });
    expect(r.verdict).toBe("abstain");
  });

  it("scores profitable value ABOVE cheap-without-profitability (Piotroski/Avantis interaction)", () => {
    // Same name, same cheapness (PEG 0.75) — only cash generation differs. The unprofitable twin
    // must lose BOTH fcf_positive and the trap guard, so profitable value strictly outranks it.
    const profitable = evaluate({ fundamentals: base({}), understandability: ok });
    const trap = evaluate({ fundamentals: base({ freeCashFlow: -1 }), understandability: ok });
    expect(profitable.checklist.find((c) => c.name === "value_trap_guard")?.result).toBe("pass");
    expect(trap.checklist.find((c) => c.name === "value_trap_guard")?.result).toBe("fail");
    expect(trap.convictionScore).toBeLessThan(profitable.convictionScore);
  });

  it("caps a value trap at 'hold' even when the rest of the checklist clears the buy band", () => {
    // High-BM+low-profitability earned ~market 1973-2023 (Avantis/Wahal) — a passing PEG on
    // negative cash flow is peak-cycle earnings or distress, and may not become a buy.
    const trap = evaluate({ fundamentals: base({ freeCashFlow: -1 }), understandability: ok });
    expect(trap.convictionScore).toBeGreaterThanOrEqual(70); // other criteria DO clear the band…
    expect(trap.verdict).toBe("hold"); // …and the cap still holds it out of "buy"
  });

  it("abstains from the trap guard when the name is not cheap — interaction, not a new FCF rule", () => {
    // PEG 1.25: the value axis never fired, so cheap-without-profitability is unmeasurable here.
    const r = evaluate({ fundamentals: base({ peRatio: 25, epsGrowthPct: 20 }), understandability: ok });
    expect(r.checklist.find((c) => c.name === "value_trap_guard")?.result).toBe("na");
  });

  it("abstains from the trap guard when FCF is unknown, and omits it for non-earnings categories", () => {
    const unknown = evaluate({ fundamentals: base({ freeCashFlow: null }), understandability: ok });
    expect(unknown.checklist.find((c) => c.name === "value_trap_guard")?.result).toBe("na");
    const cyclical = evaluate({ fundamentals: base({ earningsCyclicality: "high" }), understandability: ok });
    expect(cyclical.checklist.some((c) => c.name === "value_trap_guard")).toBe(false);
  });

  it("treats NEGATIVE equity as unknown D/E, never as 'conservatively financed'", () => {
    // The pass test was `debtToEquity < 0.33`, so buyback-driven negative equity scored as
    // MAXIMALLY conservative: MCD (-22.7), SBUX (-2.0), LOW (-4.0), ABBV (-19.7) all read as
    // pristine while BAC at 1.05 was hard-rejected. The ratio was measuring buyback accounting,
    // not solvency. Negative equity must be UNKNOWN (criterion omitted), not a free pass.
    const negEquity = evaluate({ fundamentals: base({ debtToEquity: -22.7 }), understandability: ok });
    const dte = negEquity.checklist.find((c) => c.name === "debt_to_equity");
    expect(dte?.result, "negative D/E must read as na, never pass").toBe("na");
    // ...and it must not be hard-rejected either — the gate has no information here.
    expect(negEquity.verdict, "no hard reject on unknown D/E").not.toBe("avoid");
  });

  // --- 2026-09-16 methodology audit: each case below was a wrong verdict on live SEC EDGAR data ---

  it("does not compute PEGY on shrinking earnings, however high the yield", () => {
    expect(pegy(base({ peRatio: 17, epsGrowthPct: -2.8, dividendYieldPct: 4.5 }))).toBeNull();
  });

  it("scores dividend cover for slow growers: a yield earnings cannot cover is not a buy (NKE)", () => {
    const nke = base({
      epsGrowthPct: -2.8, epsGrowthHistoryPct: [10, -40, -2.8], dividendYieldPct: 4.5, payoutRatio: 0.78,
      debtToEquity: 0.53, roePct: 21, freeCashFlow: 2e9, inventoryGrowthPct: 33.8, revenueGrowthPct: 0.2,
      institutionalOwnershipPct: null, institutionalOwnershipMedianPct: null, insiderNetBuying: null,
    });
    const r = evaluate({ fundamentals: nke, understandability: ok });
    expect(r.category).toBe("slow_grower");
    const cover = r.checklist.find((c) => c.name === "dividend_cover");
    expect(cover?.result).toBe("fail");
    expect(cover?.value).toBeCloseTo(1.282, 3);
    expect(r.verdict).not.toBe("buy");
    // Well covered, the same name is scored on the dividend it can actually sustain.
    const covered = evaluate({ fundamentals: { ...nke, payoutRatio: 0.5 }, understandability: ok });
    expect(covered.checklist.find((c) => c.name === "dividend_cover")?.result).toBe("pass");
    expect(covered.convictionScore).toBeGreaterThan(r.convictionScore);
  });

  it("abstains instead of publishing 'avoid' when the valuation inputs are missing (XOM, V)", () => {
    const blank = base({
      peRatio: null, epsGrowthPct: null, epsGrowthHistoryPct: [], dividendYieldPct: null, payoutRatio: null,
      debtToEquity: null, netCashPerShare: null, roePct: null, currentRatio: null, freeCashFlow: null,
      revenueGrowthPct: null, inventoryGrowthPct: null, marketCapUsd: null, institutionalOwnershipPct: null,
      institutionalOwnershipMedianPct: null, insiderNetBuying: null,
    });
    const r = evaluate({ fundamentals: blank, understandability: ok });
    expect(r.verdict).toBe("abstain");
    expect(r.categoryReason).toMatch(/^insufficient_data: /);
    // A growth name without a usable P/E cannot be valued on PEG, so it abstains too.
    const noPe = evaluate({ fundamentals: base({ peRatio: null }), understandability: ok });
    expect(noPe.verdict).toBe("abstain");
  });

  it("classifies oil, chemicals, autos and airlines as cyclical from SIC when the source has no signal (CVX)", () => {
    for (const sicCode of ["2911", "1311", "2821", "3711", "4512"]) {
      const r = evaluate({ fundamentals: base({ earningsCyclicality: null, sicCode }), understandability: ok });
      expect(r.category, `SIC ${sicCode}`).toBe("cyclical");
    }
    // Soaps/cosmetics (PG, 2840) and pharma are carved out of chemicals; an explicit
    // low-cyclicality signal beats the SIC.
    expect(evaluate({ fundamentals: base({ earningsCyclicality: null, sicCode: "2840" }), understandability: ok }).category).not.toBe("cyclical");
    expect(evaluate({ fundamentals: base({ earningsCyclicality: null, sicCode: "2834" }), understandability: ok }).category).not.toBe("cyclical");
    expect(evaluate({ fundamentals: base({ earningsCyclicality: "low", sicCode: "2911" }), understandability: ok }).category).not.toBe("cyclical");
  });

  it("scores a cyclical's cycle position: depressed earnings are the buy side (Lynch ch.7)", () => {
    const peak = evaluate({ fundamentals: base({ earningsCyclicality: "high", epsGrowthHistoryPct: [20, 30, 40] }), understandability: ok });
    const trough = evaluate({ fundamentals: base({ earningsCyclicality: "high", epsGrowthHistoryPct: [20, -30, -40] }), understandability: ok });
    expect(peak.checklist.find((c) => c.name === "cycle_position")?.result).toBe("fail");
    expect(trough.checklist.find((c) => c.name === "cycle_position")?.result).toBe("pass");
    expect(trough.convictionScore).toBeGreaterThan(peak.convictionScore);
  });

  it("rounds displayed criterion values but keeps whole-dollar figures exact", () => {
    const r = evaluate({ fundamentals: base({ debtToEquity: 0.2912345678, freeCashFlow: 2184000000 }), understandability: ok });
    expect(r.checklist.find((c) => c.name === "debt_to_equity")?.value).toBe(0.291);
    expect(r.checklist.find((c) => c.name === "fcf_positive")?.value).toBe(2184000000);
  });

  it("caps buys at hold for categories excluded in config (Step 2 E2), and does nothing by default", () => {
    const cfg = loadStrategyConfig().config;
    const excluded = { ...cfg, scoring: { ...cfg.scoring, buy_excluded_categories: ["fast_grower"] } };
    expect(evaluate({ fundamentals: base({}), understandability: ok }).verdict).toBe("buy");
    expect(evaluate({ fundamentals: base({}), understandability: ok, config: excluded }).verdict).toBe("hold");
  });

  it("adds the F_SCORE criterion only when the config enables it (observe-only at weight 0)", () => {
    const pio = { score: 8, computable: 9, signals: {} as never };
    const cfg = loadStrategyConfig().config;
    expect(evaluate({ fundamentals: base({ piotroski: pio }), understandability: ok }).checklist.some((c) => c.name === "f_score")).toBe(false);
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, piotroski: { enabled: true, min_score: 6 } } };
    const r = evaluate({ fundamentals: base({ piotroski: pio }), understandability: ok, config: observe });
    const c = r.checklist.find((x) => x.name === "f_score");
    expect(c?.result).toBe("pass");
    expect(c?.weight).toBe(0);
    expect(r.convictionScore).toBe(evaluate({ fundamentals: base({ piotroski: pio }), understandability: ok }).convictionScore);
    const thin = evaluate({ fundamentals: base({ piotroski: { ...pio, computable: 6 } }), understandability: ok, config: observe });
    expect(thin.checklist.find((x) => x.name === "f_score")?.result).toBe("na");
  });

  it("adds the EBIT/EV criterion only when the config enables it; financials abstain", () => {
    const cfg = loadStrategyConfig().config;
    expect(evaluate({ fundamentals: base({ ebitToEv: 0.1 }), understandability: ok }).checklist.some((c) => c.name === "ebit_ev")).toBe(false);
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, ebit_ev: { enabled: true, min_ebit_ev: 0.08 } } };
    const r = evaluate({ fundamentals: base({ ebitToEv: 0.1 }), understandability: ok, config: observe });
    const c = r.checklist.find((x) => x.name === "ebit_ev");
    expect(c?.result).toBe("pass");
    expect(c?.weight).toBe(0);
    expect(r.convictionScore).toBe(evaluate({ fundamentals: base({ ebitToEv: 0.1 }), understandability: ok }).convictionScore);
    expect(evaluate({ fundamentals: base({ ebitToEv: 0.05 }), understandability: ok, config: observe }).checklist.find((x) => x.name === "ebit_ev")?.result).toBe("fail");
    expect(evaluate({ fundamentals: base({ ebitToEv: null }), understandability: ok, config: observe }).checklist.find((x) => x.name === "ebit_ev")?.result).toBe("na");
    expect(evaluate({ fundamentals: base({ ebitToEv: 0.2, sicCode: "6021" }), understandability: ok, config: observe }).checklist.find((x) => x.name === "ebit_ev")?.result).toBe("na");
  });

  it("records individual Piotroski signals only when enabled, at weight 0", () => {
    const cfg = loadStrategyConfig().config;
    const signals = { roa: 1, cfo: 1, deltaRoa: 1, accrual: 0, deltaLever: 1, deltaLiquid: 1, eqOffer: 1, deltaMargin: 1, deltaTurn: null } as const;
    const f = base({ piotroski: { score: 7, computable: 8, signals } });
    expect(evaluate({ fundamentals: f, understandability: ok }).checklist.some((c) => c.name === "no_share_issuance")).toBe(false);
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, piotroski_signals: { enabled: true } } };
    const r = evaluate({ fundamentals: f, understandability: ok, config: observe });
    expect(r.checklist.find((c) => c.name === "no_share_issuance")?.result).toBe("pass");
    expect(r.checklist.find((c) => c.name === "cash_backed_earnings")?.result).toBe("fail");
    expect(r.checklist.find((c) => c.name === "margin_and_turnover_up")?.result).toBe("na");
    expect(r.convictionScore).toBe(evaluate({ fundamentals: f, understandability: ok }).convictionScore);
  });

  it("adds price-history criteria only when enabled, at weight 0", () => {
    const cfg = loadStrategyConfig().config;
    const f = base({ peRatio: 12, fiveYearAvgPe: 15, priceChange12mPct: -20, epsChangePct: 8 });
    expect(evaluate({ fundamentals: f, understandability: ok }).checklist.some((c) => c.name === "earnings_up_price_down")).toBe(false);
    const observe = {
      ...cfg,
      global_criteria: { ...cfg.global_criteria, earnings_up_price_down: { enabled: true }, momentum_12m: { enabled: true }, pe_vs_own_history: { enabled: true } },
    };
    const r = evaluate({ fundamentals: f, understandability: ok, config: observe });
    expect(r.checklist.find((c) => c.name === "earnings_up_price_down")?.result).toBe("pass");
    expect(r.checklist.find((c) => c.name === "momentum_12m")?.result).toBe("fail");
    expect(r.checklist.find((c) => c.name === "pe_vs_own_history")?.result).toBe("pass");
    expect(r.convictionScore).toBe(evaluate({ fundamentals: f, understandability: ok }).convictionScore);
    const unknown = evaluate({ fundamentals: base({ priceChange12mPct: null, epsChangePct: 8, fiveYearAvgPe: null }), understandability: ok, config: observe });
    expect(unknown.checklist.find((c) => c.name === "earnings_up_price_down")?.result).toBe("na");
    expect(unknown.checklist.find((c) => c.name === "pe_vs_own_history")?.result).toBe("na");
  });

  it("classifies by the config's growth bands (v0.4.1: config is the single source of truth)", () => {
    const cfg = loadStrategyConfig().config;
    expect(cfg.version).toBe("0.4.2");
    expect(cfg.portfolio_construction).toMatchObject({ core_symbol: "SPY", satellite_pct_default: 30, cash_floor_pct: 2, core_band_pct: 1 });
    expect(cfg.categories.stalwart?.id).toMatchObject({ eps_growth_pct: { gt: 5, lt: 20 } });
    // Canonical bands: 5% is a slow grower, 6% a stalwart, 20% a fast grower (unchanged from v0.4.0).
    expect(evaluate({ fundamentals: base({ epsGrowthPct: 5 }), understandability: ok }).category).toBe("slow_grower");
    expect(evaluate({ fundamentals: base({ epsGrowthPct: 6 }), understandability: ok }).category).toBe("stalwart");
    expect(evaluate({ fundamentals: base({ epsGrowthPct: 20 }), understandability: ok }).category).toBe("fast_grower");
    // Moving the band in config moves the classification: the numbers are no longer hard-coded.
    const shifted = {
      ...cfg,
      categories: { ...cfg.categories, fast_grower: { ...cfg.categories.fast_grower!, id: { eps_growth_pct: { gte: 30 } } } },
    };
    expect(evaluate({ fundamentals: base({ epsGrowthPct: 25 }), understandability: ok, config: shifted }).category).toBe("stalwart");
  });

  it("adds the insider open-market-buy criterion only when enabled, at weight 0", () => {
    const cfg = loadStrategyConfig().config;
    const f = base({ insiderPurchases180d: 2 });
    expect(evaluate({ fundamentals: f, understandability: ok }).checklist.some((c) => c.name === "insider_open_market_buy")).toBe(false);
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, insider_open_market_buy: { enabled: true } } };
    const r = evaluate({ fundamentals: f, understandability: ok, config: observe });
    expect(r.checklist.find((c) => c.name === "insider_open_market_buy")?.result).toBe("pass");
    expect(r.convictionScore).toBe(evaluate({ fundamentals: f, understandability: ok }).convictionScore);
    const none = evaluate({ fundamentals: base({ insiderPurchases180d: 0 }), understandability: ok, config: observe });
    expect(none.checklist.find((c) => c.name === "insider_open_market_buy")?.result).toBe("fail");
    const unknown = evaluate({ fundamentals: base({}), understandability: ok, config: observe });
    expect(unknown.checklist.find((c) => c.name === "insider_open_market_buy")?.result).toBe("na");
  });

  it("adds the P/E cap and EPS growth band criteria only when enabled, at weight 0", () => {
    const cfg = loadStrategyConfig().config;
    const f = base({ peRatio: 30, epsGrowthPct: 22 });
    expect(evaluate({ fundamentals: f, understandability: ok }).checklist.some((c) => c.name === "pe_cap" || c.name === "eps_growth_band")).toBe(false);
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, pe_cap: { enabled: true, max_pe: 25 }, eps_growth_band: { enabled: true, min_pct: 15, max_pct: 30 } } };
    const r = evaluate({ fundamentals: f, understandability: ok, config: observe });
    expect(r.checklist.find((c) => c.name === "pe_cap")?.result).toBe("fail");
    expect(r.checklist.find((c) => c.name === "eps_growth_band")?.result).toBe("pass");
    expect(r.convictionScore).toBe(evaluate({ fundamentals: f, understandability: ok }).convictionScore);
    expect(evaluate({ fundamentals: base({ peRatio: null }), understandability: ok, config: observe }).checklist.find((c) => c.name === "pe_cap")?.result).toBe("na");
  });

  it("caps buys at hold unless a required criterion passed, only when the config says so", () => {
    const cfg = loadStrategyConfig().config;
    const f = base({ insiderPurchases180d: 0 });
    const observe = { ...cfg, global_criteria: { ...cfg.global_criteria, insider_open_market_buy: { enabled: true } } };
    expect(evaluate({ fundamentals: f, understandability: ok, config: observe }).verdict).toBe("buy");
    const filtered = { ...observe, scoring: { ...observe.scoring, buy_require_criterion: "insider_open_market_buy" } };
    expect(evaluate({ fundamentals: f, understandability: ok, config: filtered }).verdict).toBe("hold");
    expect(evaluate({ fundamentals: base({ insiderPurchases180d: 1 }), understandability: ok, config: filtered }).verdict).toBe("buy");
    expect(evaluate({ fundamentals: base({}), understandability: ok, config: filtered }).verdict).toBe("hold"); // n/a is not a pass
  });

  it("caps buys at hold on negative EPS growth only when the config says so", () => {
    const cfg = loadStrategyConfig().config;
    const on = { ...cfg, scoring: { ...cfg.scoring, buy_block_negative_eps_growth: true } };
    // A slow grower bought for its dividend while earnings shrink.
    const f = base({ epsGrowthPct: -3, dividendYieldPct: 5, payoutRatio: 0.3, marketCapUsd: 50e9, debtToEquity: 0.1, freeCashFlow: 1e9 });
    const off = evaluate({ fundamentals: f, understandability: ok });
    expect(off.category).toBe("slow_grower");
    expect(off.verdict).toBe("buy");
    expect(evaluate({ fundamentals: f, understandability: ok, config: on }).verdict).toBe("hold");
    expect(evaluate({ fundamentals: base({}), understandability: ok, config: on }).verdict).toBe(evaluate({ fundamentals: base({}), understandability: ok }).verdict);
  });

  it("scores PEG <= 0.5 as its own criterion only when enabled", () => {
    const cfg = loadStrategyConfig().config;
    expect(evaluate({ fundamentals: base({}), understandability: ok }).checklist.some((c) => c.name === "peg_strong")).toBe(false);
    const on = { ...cfg, global_criteria: { ...cfg.global_criteria, peg_strong: { enabled: true, lte: 0.5 } } };
    const c = evaluate({ fundamentals: base({}), understandability: ok, config: on }).checklist.find((x) => x.name === "peg_strong");
    expect(c).toBeDefined();
    expect(["pass", "fail"]).toContain(c!.result);
  });

  it("canonical config v0.4.0 caps new cyclical buys at hold, and only cyclical (E2b)", () => {
    const cfg = loadStrategyConfig().config;
    expect(cfg.scoring.buy_excluded_categories).toEqual(["cyclical"]);
    const trough = base({ earningsCyclicality: "high", epsGrowthHistoryPct: [20, -30, -40] });
    const withoutExclusion = { ...cfg, scoring: { ...cfg.scoring, buy_excluded_categories: [] } };
    expect(evaluate({ fundamentals: trough, understandability: ok, config: withoutExclusion }).verdict).toBe("buy");
    const r = evaluate({ fundamentals: trough, understandability: ok });
    expect(r.category).toBe("cyclical");
    expect(r.verdict).toBe("hold");
    expect(evaluate({ fundamentals: base({}), understandability: ok }).verdict).toBe("buy"); // fast grower untouched
  });
});
