import type { DecisionRecord, Understandability } from "@dipbuyer/shared";
import { buildDecisionRecord, evaluate } from "@dipbuyer/strategy";
import { PaperBroker, maxBuyNotional, sectorHeadroom, type RiskParams } from "@dipbuyer/brokers";
import type { FundamentalsAdapter, MarketDataAdapter } from "@dipbuyer/data";
import type { BacktestParams, BacktestResult } from "./index.js";
import { computeMetrics } from "./metrics.js";

/** Documented guardrail defaults (config/strategy.lynch.json risk_guardrails). */
const RISK_DEFAULTS = { maxPositionPct: 10, minCashFloorPct: 2, maxPositions: 40, minPriceUsd: 1, maxSectorPct: 30, minAdvUsd: 1_000_000 };
/** Trailing window (bars) for the average-daily-dollar-volume liquidity gate. */
const ADV_WINDOW = 30;

/**
 * Distinguishes "the data source refused/failed" from "there is genuinely no data at this clock".
 * A symbol not yet listed is expected and survivorship-safe to skip; an HTTP failure is a broken
 * run masquerading as one. Rate limiting (429) previously took the latter path silently.
 */
function isTransportFailure(e: unknown): boolean {
  const msg = (e as Error)?.message ?? "";
  return /HTTP \d{3}|fetch failed|ECONN|ETIMEDOUT|socket|network/i.test(msg);
}

// Annualisation factor per cadence. MUST stay in lockstep with STEP_DAYS in backtest.service.ts:
// these divide the realised return to a per-year figure, so a mismatch silently mis-annualises
// CAGR and Sharpe. quarterly ≈ 4, annual = 1.
const PERIODS_PER_YEAR: Record<BacktestParams["rebalance"], number> = {
  daily: 252,
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

export interface RunDeps {
  fundamentals: FundamentalsAdapter;
  marketData: MarketDataAdapter;
  /** Per-symbol understandability gate (LLM-assisted live; supplied in backtest). Default: pass. */
  understandability?: (symbol: string) => Understandability;
  /** Optional symbol→sector map enabling the per-sector concentration cap (null = unclassified). */
  sectorOf?: (symbol: string) => string | null;
  /** Rebalance dates ascending (ISO). The harness supplies the point-in-time clock series. */
  schedule: string[];
  /**
   * Point-in-time universe: the symbols investable AS OF `clock`. Supplying this is what makes a
   * run survivorship-free — `params.universe` is a single list of names that exist TODAY, so
   * anything delisted, acquired or bankrupted during the window is structurally absent and results
   * are optimistic. Omit to fall back to the static `params.universe` (biased, but explicit).
   *
   * Names that LEAVE the universe are still screened while held, so the engine can exit them;
   * they are simply no longer buyable. See the screening pass for why that asymmetry matters.
   */
  universeAt?: (clock: string) => readonly string[];
  /**
   * Annual cash yield in percent that was KNOWN at `clock` (e.g. the previous month's 3-month
   * T-bill average). Used by cashPolicy "tbill"; null = no rate available, accrue nothing.
   */
  cashRatePct?: (clock: string) => number | null;
}

/** SPY's spread is ~0.3 bp; the sleeve is charged 1 bp each way instead of the stock-picking frictions. */
const SLEEVE_FRICTION = 1 / 10_000;

/**
 * Minimal but FAITHFUL point-in-time backtest loop. For each rebalance date it asks the SAME
 * deterministic engine used live for a verdict, then trades via the paper broker. All data is
 * fetched as-of the simulated clock, so there is no look-ahead. See the engineering design notes
 *
 * Allocation is equal-weight target, clamped by the SAME risk engine used live (@dipbuyer/brokers
 * maxBuyNotional): per-name position cap + cash floor, plus a max-open-positions cap and a
 * penny-stock exclusion. Position values are marked at the point-in-time clock price, so the caps
 * bind on live portfolio value, not stale entry cost. A liquidity gate excludes names whose trailing
 * average daily dollar volume is below the floor, and (when deps.sectorOf is supplied) a per-sector
 * concentration cap clamps buys. Benchmark return is a real buy-and-hold of params.benchmark.
 */
export async function runBacktest(params: BacktestParams, deps: RunDeps): Promise<BacktestResult> {
  const broker = new PaperBroker({
    initialCash: params.initialCapital,
    priceFor: () => 0, // overridden per-trade below via explicit limit price
    commissionBps: params.frictions.commissionBps,
  });
  const understand = deps.understandability ?? (() => okGate);
  const risk = { ...RISK_DEFAULTS, ...params.risk };
  const riskParams: RiskParams = { maxPositionPct: risk.maxPositionPct, minCashFloorPct: risk.minCashFloorPct };
  const equityCurve: Array<{ ts: string; value: number }> = [];
  const decisionRecords: DecisionRecord[] = [];
  const benchmarkPrices: number[] = [];
  // The clocks the benchmark actually priced at. Tracked separately from the prices because a
  // partial pricing failure shifts the benchmark's measurement SPAN while the strategy's span is
  // unchanged — relative return then compares two different windows and reads as alpha.
  const benchmarkClocks: string[] = [];
  const benchmarkErrors: string[] = [];
  const transportSkips: string[] = [];
  /** Symbol-clocks actually attempted — the honest denominator for the skip rate. */
  let screenAttempts = 0;
  /** Last price actually observed per symbol, across clocks. Exit price for names that stop trading. */
  const lastGoodPrice = new Map<string, number>();
  /** Names liquidated because they stopped trading, for the run summary. */
  const delistedExits: string[] = [];
  /** symbol -> clocks at which it priced but had no fundamentals (so could never be screened). */
  const unscreenable = new Map<string, number>();
  let orders = 0;
  /** Gross notional traded (buys + sells), for an HONEST turnover figure. */
  let tradedNotional = 0;
  /** Cash / equity at each mark-to-market clock, for the average cash-weight metric. */
  const cashWeights: number[] = [];
  // Friction applied to the fill price: slippage + half-spread, in basis points.
  const fric = (params.frictions.slippageBps + params.frictions.spreadBps / 2) / 10_000;

  const cashPolicy = params.cashPolicy ?? "none";
  let dipFiltered = 0;
  const SLEEVE = params.benchmark;
  const sleeveWeights: number[] = [];
  let cashInterest = 0;
  let prevClock: string | null = null;

  // Profit-taking bookkeeping: symbol -> first rebalance index it may be bought again.
  const cooldownUntil = new Map<string, number>();
  let profitTakes = 0;
  let clockIndex = -1;
  for (const clock of deps.schedule) {
    clockIndex++;
    // 0) Cash yield for the period just ended, at the rate known when it started.
    if (cashPolicy === "tbill" && prevClock !== null && deps.cashRatePct) {
      const rate = deps.cashRatePct(prevClock);
      if (rate !== null && rate > 0) {
        const days = (Date.parse(clock) - Date.parse(prevClock)) / 86_400_000;
        const interest = (await broker.getCash()) * (rate / 100) * (days / 365);
        broker.creditCash(interest);
        cashInterest += interest;
      }
    }
    prevClock = clock;

    // Per-clock price memo so sizing, position valuation and MTM agree and don't refetch.
    const priceMemo = new Map<string, number>();
    const priceOf = async (sym: string): Promise<number> => {
      const cached = priceMemo.get(sym);
      if (cached !== undefined) return cached;
      const p = await deps.marketData.getLatestPrice(sym, clock);
      priceMemo.set(sym, p);
      lastGoodPrice.set(sym, p); // survives the clock — used to exit names that stop trading
      return p;
    };
    /** Trailing average daily dollar volume as of the clock; null if no bars to assess. */
    const advUsdOf = async (sym: string): Promise<number | null> => {
      try {
        // Bounded window, NOT full history. This only ever uses the trailing ADV_WINDOW bars, but
        // it used to request from 1970 — which was silently truncated to one page before the
        // adapter followed pagination, and became a full multi-page history scan afterwards.
        // ~3x calendar slack over the bar count covers weekends and holidays.
        const start = new Date(Date.parse(clock) - ADV_WINDOW * 3 * 86_400_000).toISOString();
        const bars = await deps.marketData.getBars(sym, start, clock, "1Day");
        if (bars.length === 0) return null;
        const recent = bars.slice(-ADV_WINDOW);
        return recent.reduce((a, b) => a + b.close * b.volume, 0) / recent.length;
      } catch {
        return null;
      }
    };
    /** Dip trigger (params.dipEntry): drawdown from the 52-week closing high, optionally stabilised. */
    const isDip = async (sym: string, price: number): Promise<boolean> => {
      const dip = params.dipEntry!;
      try {
        const start = new Date(Date.parse(clock) - 366 * 86_400_000).toISOString();
        const bars = await deps.marketData.getBars(sym, start, clock, "1Day");
        if (bars.length < 60) return false; // too little history to call anything a dip
        const high = Math.max(...bars.map((b) => b.close));
        if ((high - price) / high < dip.minDrawdownPct / 100) return false;
        if (!dip.requireStabilization) return true;
        const last20 = bars.slice(-20);
        return price > last20.reduce((a, b) => a + b.close, 0) / last20.length;
      } catch {
        return false;
      }
    };
    /** Held positions valued at the current clock price (falls back to broker MV if unpriced). */
    const positionValuesAtClock = async (positions: Awaited<ReturnType<typeof broker.getPositions>>) => {
      const values: Record<string, number> = {};
      for (const p of positions) {
        try {
          values[p.symbol] = p.qty * (await priceOf(p.symbol));
        } catch {
          values[p.symbol] = p.marketValue;
        }
      }
      return values;
    };

    // 1) SCREEN every symbol first, then trade. Two passes, deliberately.
    //
    // Position size must be a function of how many names actually QUALIFY, which is unknowable
    // until the whole universe has been screened. Sizing inside a single symbol-by-symbol pass
    // forced `initialCapital / universe.length` — $10k over 46 names is $217 a position, so even
    // 10 buy candidates deployed only ~22% of capital and the rest sat in cash permanently. That
    // made a wider universe REDUCE exposure (backwards), and pinned sizing to starting capital so
    // it never compounded. Screening first fixes both, and removes the alphabetical bias where
    // names early in the universe took capital before later ones were considered.
    // The investable set AS OF this clock. With a point-in-time universe this shrinks and grows as
    // names are added to / removed from the index; without one it is the static (biased) list.
    const universeNow = new Set(deps.universeAt ? deps.universeAt(clock) : params.universe);
    // Screen the UNION of the current universe and what we still hold. A name that leaves the
    // index (delisted, acquired, bankrupt) must remain screenable or its position would never be
    // evaluated again — it would be held forever and marked at a stale price, quietly inflating
    // equity. It is not BUYABLE any more (see the candidate filter below), but it must be SELLABLE.
    // The cash sleeve is not a stock pick: never screened, never counted as a position.
    const heldBeforeScreen = (await broker.getPositions()).filter((p) => p.qty > 0 && !(cashPolicy === "benchmark" && p.symbol === SLEEVE)).map((p) => p.symbol);
    const toScreen = [...new Set([...universeNow, ...heldBeforeScreen])];
    const screened: Array<{ symbol: string; price: number; verdict: string; conviction: number; category: string; hardReject: boolean; marketCap: number | null }> = [];
    for (const symbol of toScreen) {
      screenAttempts++;
      let price: number;
      try {
        price = await priceOf(symbol);
      } catch (e) {
        // "No data at this clock" (genuinely not yet listed — survivorship-safe) and "the API
        // refused us" are DIFFERENT, and conflating them is how rate limiting silently deleted
        // names from a rebalance. Count transport failures separately so they surface.
        if (isTransportFailure(e)) {
          transportSkips.push(`${symbol}@${clock}: ${(e as Error).message}`);
          continue;
        }
        // Genuinely no price AND we hold it → the name has stopped trading (delisted, acquired,
        // bankrupt). Exit at the last price actually observed. Leaving it be would carry the
        // position at a stale mark for the rest of the run, so a collapse like SIVB would enter
        // the universe without its loss ever landing — a survivorship fix in name only.
        //
        // Liquidating at the last close models the COMMON case (acquisition/merger, where holders
        // are paid near market) and is deliberately optimistic in the rare bankruptcy tail, where
        // holders got ~nothing. Distinguishing the two needs a corporate-actions source we do not
        // have. Documented, not hidden.
        const heldQty = (await broker.getPositions()).find((p) => p.symbol === symbol)?.qty ?? 0;
        const exitPrice = lastGoodPrice.get(symbol);
        if (heldQty > 0 && exitPrice !== undefined) {
          const fill = exitPrice * (1 - fric);
          await broker.placeOrder({ side: "sell", qtyOrNotional: String(heldQty), orderType: "limit", limitPrice: String(fill), idempotencyKey: `${clock}:${symbol}:delist`, symbol } as Parameters<typeof broker.placeOrder>[0] & { symbol: string });
          orders++;
          tradedNotional += heldQty * fill;
          delistedExits.push(`${symbol}@${clock}`);
        }
        continue;
      }
      let fundamentals;
      try {
        fundamentals = await deps.fundamentals.getFundamentals(symbol, clock);
      } catch (e) {
        if (isTransportFailure(e)) {
          transportSkips.push(`${symbol}@${clock}: ${(e as Error).message}`);
          continue;
        }
        // A name that PRICES but has no fundamentals is unscreenable, and skipping it silently is
        // how a survivorship fix becomes cosmetic: SEC EDGAR resolves tickers to CIKs from a
        // CURRENT-STATE map, so every delisted company (SIVB, FRC, ATVI) fails here even though
        // Alpaca serves its prices perfectly well. The point-in-time universe then contains the
        // dead names but can never screen — let alone buy — a single one of them.
        unscreenable.set(symbol, (unscreenable.get(symbol) ?? 0) + 1);
        continue;
      }

      const result = evaluate({ fundamentals, understandability: understand(symbol) });
      if (result.verdict !== "abstain") {
        decisionRecords.push(
          buildDecisionRecord(result, {
            decisionId: `${clock}:${symbol}`,
            ts: clock,
            mode: "RESEARCH_ONLY",
            execution: "PAPER",
            modelId: "backtest",
            promptVersion: "0.1",
            understandability: understand(symbol),
            dataProvenance: [
              { field: "price", source: "in-memory", asOf: clock },
              { field: "fundamentals", source: "in-memory", asOf: fundamentals.asOf },
            ],
          }),
        );
      }
      screened.push({
        symbol,
        price,
        verdict: result.verdict,
        conviction: result.convictionScore,
        category: result.category,
        hardReject: result.checklist.some((c) => c.note?.startsWith("REJECT")),
        marketCap: fundamentals.marketCapUsd,
      });
    }

    // 1a) SELLS FIRST — frees cash before sizing buys, so exits fund entries in the same clock.
    const hardRulesOnly = params.sellPolicy === "hard-rules";
    for (const { symbol, price, verdict, category, hardReject } of screened) {
      const held = (await broker.getPositions()).find((p) => p.symbol === symbol);
      if (!held || held.qty <= 0) continue;
      const ruleSell = hardRulesOnly ? verdict === "sell" || hardReject : verdict === "sell" || verdict === "avoid";
      const pt = params.profitTake;
      const profitSell = !!pt && pt.categories.includes(category) && held.avgEntryPrice > 0 && (price / held.avgEntryPrice - 1) * 100 >= pt.gainPct;
      if (!ruleSell && !profitSell) continue;
      if (profitSell && !ruleSell) {
        profitTakes++;
        cooldownUntil.set(symbol, clockIndex + pt!.cooldownPeriods);
      }
      const fill = price * (1 - fric); // receive less on exit
      tradedNotional += held.qty * fill;
      await broker.placeOrder({ side: "sell", qtyOrNotional: String(held.qty), orderType: "limit", limitPrice: String(fill), idempotencyKey: `${clock}:${symbol}:sell`, symbol } as Parameters<typeof broker.placeOrder>[0] & { symbol: string });
      orders++;
    }

    // 1b-pre) Sell the cash sleeve so picks are funded first; it is rebuilt after buys.
    if (cashPolicy === "benchmark") {
      const sleeve = (await broker.getPositions()).find((p) => p.symbol === SLEEVE && p.qty > 0);
      if (sleeve) {
        try {
          const fill = (await priceOf(SLEEVE)) * (1 - SLEEVE_FRICTION);
          await broker.placeOrder({ side: "sell", qtyOrNotional: String(sleeve.qty), orderType: "limit", limitPrice: String(fill), idempotencyKey: `${clock}:${SLEEVE}:sleeve-sell`, symbol: SLEEVE } as Parameters<typeof broker.placeOrder>[0] & { symbol: string });
          tradedNotional += sleeve.qty * fill;
        } catch {
          // Unpriced benchmark at this clock: keep the sleeve, picks use the cash that is there.
        }
      }
    }

    // 1b) BUYS — sized off CURRENT equity (so it compounds) split across the number of positions
    // we actually intend to hold, capped by maxPositions.
    {
      const positionsNow = (await broker.getPositions()).filter((p) => !(cashPolicy === "benchmark" && p.symbol === SLEEVE));
      const heldSymbols = new Set(positionsNow.filter((p) => p.qty > 0).map((p) => p.symbol));
      // Sorted by CONVICTION, not ticker. `Sp500Membership.at()` returns names alphabetically, so
      // whenever cash or the 40-slot cap binds, A-tickers systematically took capital first and
      // Z-tickers were starved — an arbitrary allocation bias with nothing behind it. The engine
      // already computes convictionScore and the sizing path simply discarded it.
      const candidates = screened.filter(
        (s) =>
          s.verdict === "buy" &&
          // Screened-but-departed names are exit-only: buying a name that has already left the
          // index at this clock would be look-ahead of the worst kind (we would be buying it
          // BECAUSE we know it survives to appear in today's list).
          universeNow.has(s.symbol) &&
          !heldSymbols.has(s.symbol) &&
          !((cooldownUntil.get(s.symbol) ?? -1) > clockIndex) &&
          s.price >= risk.minPriceUsd,
      ).sort((a, b) => b.conviction - a.conviction);
      if (params.dipEntry) {
        const kept: typeof candidates = [];
        for (const c of candidates) if (await isDip(c.symbol, c.price)) kept.push(c);
        dipFiltered += candidates.length - kept.length;
        candidates.splice(0, candidates.length, ...kept);
      }
      const intendedPositions = Math.min(risk.maxPositions, heldSymbols.size + candidates.length);
      if (intendedPositions > 0) {
        const cashNow = await broker.getCash();
        const valuesNow = await positionValuesAtClock(positionsNow);
        const equityNow = cashNow + Object.values(valuesNow).reduce((a, b) => a + b, 0);
        const equalWeight = equityNow / intendedPositions;
        // Market-cap sizing: weight against the cap of everything we will hold after this clock.
        const capOf = new Map(screened.map((s) => [s.symbol, s.marketCap]));
        const capTotal =
          params.sizing === "market-cap"
            ? [...heldSymbols, ...candidates.map((c) => c.symbol)].reduce((a, s) => a + (capOf.get(s) ?? 0), 0)
            : 0;
        // Sector-neutral: sector share of the index universe's cap x the name's share of its sector's picks.
        const sectorKey = (s: string) => deps.sectorOf?.(s) ?? "unclassified";
        const indexCap = new Map<string, number>();
        const pickCap = new Map<string, number>();
        let indexTotal = 0;
        if (params.sizing === "sector-neutral") {
          for (const s of screened) {
            if (!universeNow.has(s.symbol) || !s.marketCap) continue;
            indexCap.set(sectorKey(s.symbol), (indexCap.get(sectorKey(s.symbol)) ?? 0) + s.marketCap);
            indexTotal += s.marketCap;
          }
          for (const s of [...heldSymbols, ...candidates.map((c) => c.symbol)]) {
            const cap = capOf.get(s);
            if (cap) pickCap.set(sectorKey(s), (pickCap.get(sectorKey(s)) ?? 0) + cap);
          }
        }
        const baseTarget = (symbol: string): number => {
          const cap = capOf.get(symbol);
          if (params.sizing === "sector-neutral") {
            const sec = sectorKey(symbol);
            const inSector = pickCap.get(sec) ?? 0;
            return indexTotal > 0 && cap && inSector > 0 ? equityNow * ((indexCap.get(sec) ?? 0) / indexTotal) * (cap / inSector) : equalWeight;
          }
          return capTotal > 0 && cap ? (equityNow * cap) / capTotal : equalWeight;
        };

        for (const { symbol, price } of candidates) {
          const positions = (await broker.getPositions()).filter((p) => !(cashPolicy === "benchmark" && p.symbol === SLEEVE));
          const openCount = positions.filter((p) => p.qty > 0).length;
          if (openCount >= risk.maxPositions) break; // cap reached
          const adv = risk.minAdvUsd > 0 ? await advUsdOf(symbol) : null;
          if (adv !== null && adv < risk.minAdvUsd) continue; // too illiquid

          const cash = await broker.getCash();
          const positionValues = await positionValuesAtClock(positions);
          // Clamp the equal-weight target by the position-cap + cash-floor risk engine,
          // and (when a sector map is supplied) by the per-sector concentration cap.
          const allowedByName = maxBuyNotional({ symbol, cash, positionValues }, riskParams);
          const allowedBySector = deps.sectorOf
            ? sectorHeadroom({ sector: deps.sectorOf(symbol), cash, positionValues, sectorOf: deps.sectorOf }, { maxSectorPct: risk.maxSectorPct })
            : Infinity;
          const targetNotional = Math.min(baseTarget(symbol), allowedByName, allowedBySector);
          const fill = price * (1 + fric); // pay up on entry
          // FRACTIONAL, not floored. Math.floor on a $10k book gave a ~$250 per-name target, so
          // ANY stock priced above that got qty=0 and was skipped SILENTLY — at raw pre-split
          // prices that structurally excluded AMZN (~$2,400), GOOGL (~$2,900), NVDA (~$1,200),
          // BKNG, CMG, AZO. The screen could not buy the decade's biggest winners regardless of
          // what it thought of them. Flooring also undershot every target by ~half a share and
          // never redistributed the remainder. Alpaca supports fractional shares, so this is also
          // the more faithful model of what we would really trade.
          const qty = targetNotional / fill;
          if (qty > 0) {
            await broker.placeOrder({ side: "buy", qtyOrNotional: String(qty), orderType: "limit", limitPrice: String(fill), idempotencyKey: `${clock}:${symbol}:buy`, symbol } as Parameters<typeof broker.placeOrder>[0] & { symbol: string });
            tradedNotional += qty * fill;
            orders++;
          }
        }
      }
    }

    // 1c) Rebuild the cash sleeve with everything above the cash floor.
    if (cashPolicy === "benchmark") {
      try {
        const px = await priceOf(SLEEVE);
        const cash = await broker.getCash();
        let equityNow = cash;
        for (const p of await broker.getPositions()) {
          try {
            equityNow += p.qty * (await priceOf(p.symbol));
          } catch {
            equityNow += p.marketValue;
          }
        }
        const excess = cash - (equityNow * risk.minCashFloorPct) / 100;
        const fill = px * (1 + SLEEVE_FRICTION);
        const qty = excess / (fill * (1 + params.frictions.commissionBps / 10_000));
        if (qty > 0) {
          await broker.placeOrder({ side: "buy", qtyOrNotional: String(qty), orderType: "limit", limitPrice: String(fill), idempotencyKey: `${clock}:${SLEEVE}:sleeve-buy`, symbol: SLEEVE } as Parameters<typeof broker.placeOrder>[0] & { symbol: string });
          tradedNotional += qty * fill;
        }
      } catch {
        // benchmark unpriced at this clock: cash stays idle this period
      }
    }

    // 2) Mark-to-market the portfolio at this clock.
    const positions = await broker.getPositions();
    const cashAtClock = await broker.getCash();
    let mv = cashAtClock;
    for (const p of positions) {
      try {
        mv += p.qty * (await priceOf(p.symbol));
      } catch {
        mv += p.marketValue;
      }
    }
    equityCurve.push({ ts: clock, value: mv });
    cashWeights.push(mv > 0 ? cashAtClock / mv : 0);
    if (cashPolicy === "benchmark") {
      const sleeve = positions.find((p) => p.symbol === SLEEVE);
      let sleeveValue = 0;
      if (sleeve) {
        try {
          sleeveValue = sleeve.qty * (await priceOf(SLEEVE));
        } catch {
          sleeveValue = sleeve.marketValue;
        }
      }
      sleeveWeights.push(mv > 0 ? sleeveValue / mv : 0);
    }

    // 3) Track the benchmark for a real relative-return comparison (skip clocks it's unpriced).
    try {
      benchmarkPrices.push(await priceOf(params.benchmark));
      benchmarkClocks.push(clock);
    } catch (e) {
      benchmarkErrors.push((e as Error).message);
    }
  }

  const equity = equityCurve.map((e) => e.value);
  // Benchmark buy-and-hold return over the priced span (undefined → relative == total return).
  const benchFirst = benchmarkPrices[0];
  const benchLast = benchmarkPrices.at(-1);
  const benchmarkReturnPct =
    benchFirst !== undefined && benchLast !== undefined && benchFirst > 0
      ? ((benchLast - benchFirst) / benchFirst) * 100
      : undefined;
  // A benchmark that NEVER priced is a configuration error, not a quiet edge case — an
  // unpriceable symbol previously produced a null comparison that read as market-beating.
  // Transport failures removed names from rebalances. A run missing part of its universe is NOT a
  // valid result, so say so loudly rather than returning quietly-wrong metrics.
  if (transportSkips.length) {
    // Denominator is the symbol-clocks actually ATTEMPTED, not schedule × params.universe — with a
    // point-in-time universe the investable set varies per clock, so the static product would
    // understate the skip rate whenever the universe was smaller than today's list.
    const pctSkipped = screenAttempts ? (transportSkips.length / screenAttempts) * 100 : 0;
    console.warn(
      `[backtest] ${transportSkips.length} symbol-clocks skipped due to DATA-SOURCE FAILURES ` +
        `(${pctSkipped.toFixed(1)}% of the grid), e.g. "${transportSkips[0]}". These are NOT ` +
        `"not yet listed" — the source refused or failed, so those names silently left the ` +
        `universe at those clocks. Treat these metrics as unreliable.`,
    );
  }

  if (unscreenable.size) {
    const names = [...unscreenable.keys()].sort();
    console.warn(
      `[backtest] ${unscreenable.size} symbol(s) PRICED but had NO FUNDAMENTALS at any clock, so ` +
        `they were never screened and could never be bought: ${names.slice(0, 12).join(", ")}` +
        `${names.length > 12 ? `, +${names.length - 12} more` : ""}. ` +
        `With a point-in-time universe this is usually SEC EDGAR's ticker->CIK map being ` +
        `CURRENT-STATE ONLY, which excludes exactly the delisted companies the universe exists to ` +
        `include. SURVIVORSHIP CONTROL IS THEREFORE INCOMPLETE and results remain optimistic.`,
    );
  }

  if (delistedExits.length) {
    console.warn(
      `[backtest] ${delistedExits.length} position(s) liquidated because the symbol stopped ` +
        `trading, e.g. "${delistedExits[0]}". Exit was the LAST OBSERVED CLOSE, which models an ` +
        `acquisition well but is optimistic for a bankruptcy (holders of SIVB/FRC got ~nothing). ` +
        `Distinguishing the two needs a corporate-actions source.`,
    );
  }

  if (benchmarkReturnPct === undefined && benchmarkErrors.length) {
    console.warn(
      `[backtest] benchmark "${params.benchmark}" could not be priced at any clock ` +
        `(${benchmarkErrors.length} failures, e.g. "${benchmarkErrors[0]}"). ` +
        `benchmarkRelativePct will be null. Index tickers such as ^GSPC are not tradeable ` +
        `symbols — use an ETF proxy like SPY.`,
    );
  }

  // A benchmark that priced at SOME clocks is the dangerous case: it yields a plausible number
  // with no signal that anything failed. Only the endpoints matter — the buy-and-hold return is
  // first-to-last — so a gap in the middle is harmless, but a missing FIRST or LAST clock measures
  // the benchmark over a shorter window than the strategy and books the difference as alpha.
  const strategyFirst = equityCurve[0]?.ts;
  const strategyLast = equityCurve.at(-1)?.ts;
  const benchSpanFirst = benchmarkClocks[0];
  const benchSpanLast = benchmarkClocks.at(-1);
  if (
    benchmarkReturnPct !== undefined &&
    (benchSpanFirst !== strategyFirst || benchSpanLast !== strategyLast)
  ) {
    // The overwhelmingly common cause is the FIRST clock, so name it rather than making the next
    // person re-derive it. Daily bars are stamped at the session open in EXCHANGE-LOCAL time
    // (Alpaca: 05:00Z = midnight ET), while clocks are midnight UTC. `getLatestPrice` takes the
    // last bar at-or-before the clock, so a midnight-UTC clock resolves to the PREVIOUS trading
    // day's close — correct and look-ahead-safe everywhere except the first day data exists,
    // where no earlier bar exists and the fetch refuses. Picking "a trading day" does NOT help;
    // the guard fired twice on that advice. Start one trading day AFTER the source's floor.
    const firstClockFailed = benchSpanFirst !== strategyFirst;
    console.warn(
      `[backtest] benchmark "${params.benchmark}" priced over ${benchSpanFirst}..${benchSpanLast} ` +
        `but the strategy ran ${strategyFirst}..${strategyLast} — ${benchmarkErrors.length} clock(s) ` +
        `failed to price, e.g. "${benchmarkErrors[0]}". benchmarkRelativePct compares TWO DIFFERENT ` +
        `WINDOWS and is not a valid alpha figure. Do not cite it.` +
        (firstClockFailed
          ? ` The FIRST clock is the one that failed. This is usually NOT a market holiday: daily ` +
            `bars are stamped in exchange-local time (05:00Z) while clocks are midnight UTC, so a ` +
            `clock landing on the data source's earliest available day has no bar at-or-before it. ` +
            `Start the window one trading day AFTER the source's floor.`
          : ""),
    );
  }
  const metrics = computeMetrics(equity, { periodsPerYear: PERIODS_PER_YEAR[params.rebalance], benchmarkReturnPct });
  // REAL turnover: gross notional traded over average equity, annualised. The old figure was
  // `orders / clocks * 100` — an orders-per-clock count wearing a percent sign, which made the
  // friction bill impossible to estimate from the metrics and hid any churn.
  const avgEquity = equity.length ? equity.reduce((a, b) => a + b, 0) / equity.length : 0;
  // Annualise over the rebalance periods that actually elapsed. A single-clock run has no
  // elapsed time, so annualised turnover is undefined there — assert on `orders` instead.
  const years = equity.length / PERIODS_PER_YEAR[params.rebalance];
  metrics.turnoverPct = avgEquity > 0 && years > 0 ? (tradedNotional / avgEquity / years) * 100 : 0;
  // Equal-weighted across clocks (each rebalance period counts once), matching how the equity curve
  // feeds CAGR. Flagged as a likely underperformance cause: idle cash vs a fully-invested SPY.
  metrics.avgCashPct = cashWeights.length ? (cashWeights.reduce((a, b) => a + b, 0) / cashWeights.length) * 100 : 0;
  if (cashPolicy === "benchmark") {
    metrics.avgSleevePct = sleeveWeights.length ? (sleeveWeights.reduce((a, b) => a + b, 0) / sleeveWeights.length) * 100 : 0;
  }
  if (cashPolicy === "tbill") metrics.cashInterestPct = (cashInterest / params.initialCapital) * 100;
  if (params.profitTake) {
    console.warn(`[backtest] profit-taking ${JSON.stringify(params.profitTake)} sold ${profitTakes} position(s) on gains`);
  }
  if (params.dipEntry) {
    console.warn(`[backtest] dip entry ${JSON.stringify(params.dipEntry)} skipped ${dipFiltered} buy-verdict entries that were not dips`);
  }

  return {
    orders,
    params,
    equityCurve,
    metrics,
    decisionRecords,
    dataSourceFailures: transportSkips.length,
    provenance: {
      dataSnapshotId: "in-memory",
      strategyConfigHash: "see DecisionRecord.model.strategyConfigHash",
      codeCommit: "uncommitted",
      seed: params.seed,
    },
  };
}

const okGate: Understandability = { passed: true, businessSummary: "n/a (backtest)", growthStory: "n/a" };
