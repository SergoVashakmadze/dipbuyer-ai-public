import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException, Optional } from "@nestjs/common";
import type { AgentRun, AgentRunStore, AnalyzeOptions, DecisionService, TradeProposal } from "@dipbuyer/agent";
import { planTrades } from "@dipbuyer/agent";
import { allocationFromConfig, checkRisk, guardrailsFromConfig, maxBuyNotional, planCore, satelliteCash, sectorHeadroom, sizeBuys, type IBroker } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import { loadStrategyConfig } from "@dipbuyer/strategy";
import { sectorForSic, type RuntimeMode } from "@dipbuyer/shared";
import { DECISION_SERVICE } from "../decision/decision.providers.js";
import { BROKER } from "../orders/orders.providers.js";
import { MARKET_DATA } from "../orders/market-data.provider.js";
import { LEDGER_STORE, LedgerStore } from "../orders/portfolio.store.js";
import { SuitabilityService } from "../suitability/suitability.service.js";
import { KycService } from "../kyc/kyc.service.js";
import { researchUniverse } from "../research/universe.js";

export const AGENT_RUN_STORE = "AGENT_RUN_STORE";

export interface AgentRunRequest {
  universe?: string[];
  /** If true, only produce the plan; never place orders. Forced true outside DISCRETIONARY mode. */
  dryRun?: boolean;
  /** Share of equity for the Lynch picks (0-100); the rest goes to the index core. Default from config. */
  satellitePct?: number;
}

export interface ApproveRequest {
  proposalIds: string[];
  userId: string;
}

interface Gate {
  ok: boolean;
  reason?: string;
}

/**
 * The investing agent: screen a universe with the Lynch engine, plan buys and sells against the
 * current book, size buys exactly as the backtest does, then either
 *   - wait for a human to approve selected trades (ADVISORY or DISCRETIONARY), or
 *   - execute them itself (DISCRETIONARY only, or a scheduled run with auto-execute switched on).
 * Every run is stored with its decisions, proposals and broker results. The engine decides; this
 * service never overrides a verdict.
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(DECISION_SERVICE) private readonly decisions: DecisionService,
    @Inject(BROKER) private readonly broker: IBroker,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataAdapter,
    @Inject(AGENT_RUN_STORE) private readonly runs: AgentRunStore,
    @Optional() private readonly suitability?: SuitabilityService,
    @Optional() private readonly kyc?: KycService,
    @Optional() @Inject(LEDGER_STORE) private readonly ledger?: LedgerStore,
  ) {}

  private mode(): RuntimeMode {
    return (process.env.RUNTIME_MODE as RuntimeMode) ?? "RESEARCH_ONLY";
  }
  private execution(): "PAPER" | "LIVE" {
    return process.env.RUNTIME_EXECUTION === "LIVE" ? "LIVE" : "PAPER";
  }
  private liveBlocked(): string | null {
    return this.execution() === "LIVE" && process.env.LIVE_TRADING_ENABLED !== "true" ? "live trading is not enabled (LIVE_TRADING_ENABLED)" : null;
  }

  /** Can a person approve proposed trades? Needs advisory or discretionary mode, KYC and suitability. */
  approvalGate(userId?: string): Gate {
    const mode = this.mode();
    if (process.env.RUNTIME_HALT === "true") return { ok: false, reason: "trading is halted (RUNTIME_HALT kill switch)" };
    const live = this.liveBlocked();
    if (live) return { ok: false, reason: live };
    if (mode === "RESEARCH_ONLY") return { ok: false, reason: "the API runs in RESEARCH_ONLY mode, which never places orders" };
    if (userId !== undefined) {
      if (!userId) return { ok: false, reason: "a signed-in user is required to approve trades" };
      if (this.kyc && !this.kyc.isValid(userId)) return { ok: false, reason: "identity verification (KYC) is required before trades can be approved" };
      if (this.suitability && !this.suitability.isValid(userId)) return { ok: false, reason: "a valid suitability assessment is required before trades can be approved" };
    }
    return { ok: true };
  }

  /** Can the agent place orders on its own? DISCRETIONARY mode only. */
  autonomousGate(): Gate {
    if (process.env.RUNTIME_HALT === "true") return { ok: false, reason: "trading is halted (RUNTIME_HALT kill switch)" };
    const live = this.liveBlocked();
    if (live) return { ok: false, reason: live };
    if (this.mode() !== "DISCRETIONARY") return { ok: false, reason: `execution blocked in ${this.mode()} mode` };
    return { ok: true };
  }

  status() {
    const { config } = loadStrategyConfig();
    return {
      mode: this.mode(),
      execution: this.execution(),
      broker: this.broker.id ?? "unknown",
      halted: process.env.RUNTIME_HALT === "true",
      canApprove: this.approvalGate().ok,
      approveBlockedReason: this.approvalGate().reason ?? null,
      canAutoExecute: this.autonomousGate().ok,
      autoExecuteBlockedReason: this.autonomousGate().reason ?? null,
      guardrails: guardrailsFromConfig(config.risk_guardrails),
      allocation: allocationFromConfig(config.portfolio_construction),
      strategyVersion: config.version,
      defaultUniverse: researchUniverse(),
    };
  }

  async listRuns(limit = 20) {
    return this.runs.recent(limit);
  }

  async getRun(id: string) {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException(`No agent run ${id}`);
    return run;
  }

  /** Screen, decide and propose. Places nothing. */
  async plan(opts: { universe?: string[]; trigger?: AgentRun["trigger"]; satellitePct?: number } = {}): Promise<AgentRun> {
    const mode = this.mode();
    const analyzeOpts: AnalyzeOptions = { mode, execution: this.execution() };
    const { config } = loadStrategyConfig();
    let policy;
    try {
      policy = allocationFromConfig(config.portfolio_construction, opts.satellitePct);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const requested = (opts.universe ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const allPositions = (await this.broker.getPositions()).filter((p) => p.qty > 0);
    // The core ETF is an allocation, not a stock pick: never screened, never sold on a verdict.
    const corePosition = allPositions.find((p) => p.symbol === policy.coreSymbol);
    const positions = allPositions.filter((p) => p.symbol !== policy.coreSymbol);
    // Screen what we hold as well, or a held name outside the universe could never be sold.
    const universe = [...new Set([...(requested.length ? requested : researchUniverse()), ...positions.map((p) => p.symbol)])].filter(
      (s) => s !== policy.coreSymbol,
    );

    const run: AgentRun = {
      id: randomUUID(),
      trigger: opts.trigger ?? "manual",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      mode,
      execution: this.execution(),
      status: "planned",
      universe,
      unavailable: [],
      decisions: [],
      sizing: null,
      proposals: [],
    };

    try {
      const sectorOf = new Map<string, string | null>();
      const info = new Map<string, { category: string | null; hash: string | null }>();
      const decided = await mapLimit(universe, 3, async (symbol) => {
        try {
          const withInputs = (this.decisions as Partial<DecisionService>).analyzeWithInputs;
          const res = withInputs
            ? await withInputs.call(this.decisions, symbol, analyzeOpts)
            : { output: await this.decisions.analyze(symbol, analyzeOpts), fundamentals: null };
          const r = res.output.record;
          sectorOf.set(symbol, res.fundamentals ? sectorForSic(res.fundamentals.sicCode) : null);
          info.set(symbol, { category: r.lynchCategory ?? null, hash: res.output.hash ?? null });
          return { symbol, verdict: r.verdict, convictionScore: r.convictionScore };
        } catch {
          run.unavailable.push(symbol);
          return null;
        }
      });
      const ok = decided.filter((d): d is NonNullable<typeof d> => d !== null);
      run.decisions = ok.map((d) => ({ ...d, lynchCategory: info.get(d.symbol)?.category ?? null, hash: info.get(d.symbol)?.hash ?? null }));

      const plan = planTrades(ok, positions);
      const priceOf = async (s: string, fallback = 0) => this.marketData.getLatestPrice(s).catch(() => fallback);
      const held = await Promise.all(
        positions.map(async (p) => ({ symbol: p.symbol, qty: p.qty, price: await priceOf(p.symbol, p.avgEntryPrice), sector: sectorOf.get(p.symbol) ?? null })),
      );
      const cash = await this.broker.getCash();
      const byVerdict = new Map(ok.map((d) => [d.symbol, d]));

      for (const symbol of plan.sells) {
        const h = held.find((x) => x.symbol === symbol)!;
        const d = byVerdict.get(symbol)!;
        run.proposals.push({
          id: randomUUID(), side: "sell", symbol, qty: h.qty, price: h.price, notional: h.qty * h.price,
          verdict: d.verdict, convictionScore: d.convictionScore, lynchCategory: info.get(symbol)?.category ?? null,
          sector: h.sector, decisionHash: info.get(symbol)?.hash ?? null,
          reason: `Held, and the engine now rates it ${d.verdict} (conviction ${d.convictionScore}/100)`, status: "proposed",
        });
      }

      const candidates = await Promise.all(
        plan.buys.map(async (symbol) => ({ symbol, price: await priceOf(symbol), convictionScore: byVerdict.get(symbol)!.convictionScore, sector: sectorOf.get(symbol) ?? null })),
      );
      // Core + satellite: the picks are sized as if the satellite budget were the whole portfolio,
      // so name and sector caps apply within it; sold picks free budget, and the core funds the rest.
      const kept = held.filter((h) => !plan.sells.includes(h.symbol));
      const keptValue = kept.reduce((t, h) => t + h.qty * h.price, 0);
      const corePrice = await priceOf(policy.coreSymbol, corePosition?.avgEntryPrice ?? 0);
      const coreValue = corePosition ? corePosition.qty * corePrice : 0;
      const totalEquity = cash + coreValue + held.reduce((t, h) => t + h.qty * h.price, 0);
      const wholeShares = this.broker.id !== "paper";
      const sized = sizeBuys({
        candidates,
        held: kept.map((h) => ({ symbol: h.symbol, value: h.qty * h.price, sector: h.sector })),
        cash: satelliteCash(totalEquity, keptValue, policy),
        guardrails: guardrailsFromConfig(config.risk_guardrails),
        wholeShares,
      });
      run.sizing = { equity: sized.equity, cash, intendedPositions: sized.intendedPositions, equalWeight: sized.equalWeight };
      for (const b of sized.buys) {
        const d = byVerdict.get(b.symbol)!;
        run.proposals.push({
          id: randomUUID(), side: "buy", symbol: b.symbol, qty: b.qty, price: b.price, notional: b.notional,
          verdict: d.verdict, convictionScore: d.convictionScore, lynchCategory: info.get(b.symbol)?.category ?? null,
          sector: sectorOf.get(b.symbol) ?? null, decisionHash: info.get(b.symbol)?.hash ?? null,
          reason: `Lynch buy at conviction ${d.convictionScore}/100, not yet held`,
          status: b.qty > 0 ? "proposed" : "skipped",
          ...(b.skipReason ? { skipReason: b.skipReason } : {}),
          ...(b.limitedBy ? { limitedBy: b.limitedBy } : {}),
        });
      }
      const picksValueAfter = keptValue + sized.buys.reduce((t, b) => t + b.notional, 0);
      const core = planCore({ totalEquity, coreValue, picksValueAfter, price: corePrice, policy, wholeShares });
      run.allocation = {
        coreSymbol: policy.coreSymbol,
        satellitePct: policy.satellitePct,
        totalEquity,
        coreValue,
        satelliteValue: keptValue,
        satelliteBudget: (totalEquity * policy.satellitePct) / 100,
        coreTarget: core?.target ?? null,
      };
      if (core) {
        run.proposals.push({
          id: randomUUID(), role: "core", side: core.side, symbol: policy.coreSymbol, qty: core.qty, price: corePrice, notional: core.notional,
          verdict: "core", convictionScore: 0, lynchCategory: null, sector: null, decisionHash: null,
          reason:
            core.side === "buy"
              ? `Core: invest cash not used by the ${policy.satellitePct}% satellite in ${policy.coreSymbol} (target $${Math.round(core.target).toLocaleString("en-US")})`
              : `Core: sell ${policy.coreSymbol} to fund the satellite (target $${Math.round(core.target).toLocaleString("en-US")})`,
          status: "proposed",
        });
      }
      run.note = run.proposals.some((p) => p.status === "proposed") ? undefined : "No trades to propose: nothing new rates a buy, nothing held rates a sell, and the core is on target.";
    } catch (e) {
      run.status = "failed";
      run.note = (e as Error).message;
    }
    run.finishedAt = new Date().toISOString();
    await this.runs.save(run);
    return run;
  }

  /** A person approves selected proposals; each becomes one paper (or enabled live) order. */
  /**
   * Execute every proposal of a run on a SIMULATED book (a model portfolio), without the mode and
   * approval gates. Refuses on any other broker: real and paper-account orders always go through
   * approve() or the discretionary gate.
   */
  async executeSimulated(runId: string, actor: string): Promise<AgentRun> {
    if ((this.broker as { simulated?: boolean }).simulated !== true) throw new ForbiddenException("executeSimulated is only for simulated model books");
    const run = await this.getRun(runId);
    await this.execute(run, new Set(run.proposals.map((p) => p.id)), actor);
    return run;
  }

  /** Store a plan built elsewhere (a model copy plan) so it can be reviewed and approved like any run. */
  async savePlanned(run: AgentRun): Promise<AgentRun> {
    await this.runs.save(run);
    return run;
  }

  async approve(runId: string, req: ApproveRequest): Promise<AgentRun> {
    const gate = this.approvalGate(req?.userId ?? "");
    if (!gate.ok) throw new ForbiddenException(`Cannot place trades: ${gate.reason}`);
    if (!Array.isArray(req.proposalIds) || req.proposalIds.length === 0) throw new BadRequestException("proposalIds is required");
    const run = await this.getRun(runId);
    await this.execute(run, new Set(req.proposalIds), `user:${req.userId}`);
    return run;
  }

  /**
   * Places the chosen proposals: sells first, then buys in conviction order. Every buy is re-checked
   * against the live book (position cap, cash floor, sector cap) because prices and holdings may have
   * moved since the plan. The idempotency key is per run AND proposal, so a retry cannot double-fill
   * but a later run can buy the same name again.
   */
  private async execute(run: AgentRun, ids: Set<string>, actor: string): Promise<void> {
    const { config } = loadStrategyConfig();
    const g = guardrailsFromConfig(config.risk_guardrails);
    const chosen = run.proposals.filter((p) => ids.has(p.id) && p.status === "proposed");
    // Sells first (core sells fund picks), then pick buys by conviction, then the core buy with what is left.
    const ordered = [
      ...chosen.filter((p) => p.side === "sell"),
      ...chosen.filter((p) => p.side === "buy" && p.role !== "core").sort((a, b) => b.convictionScore - a.convictionScore),
      ...chosen.filter((p) => p.side === "buy" && p.role === "core"),
    ];
    const sectorBySymbol = new Map(run.proposals.map((p) => [p.symbol, p.sector]));

    for (const p of ordered) {
      const now = new Date().toISOString();
      const done = (patch: Partial<TradeProposal>) => Object.assign(p, { decidedAt: now, decidedBy: actor }, patch);
      try {
        const price = await this.marketData.getLatestPrice(p.symbol).catch(() => p.price);
        let qty = p.qty;
        if (p.side === "sell") {
          const pos = (await this.broker.getPositions()).find((x) => x.symbol === p.symbol);
          if (!pos || pos.qty <= 0) {
            done({ status: "skipped", skipReason: "no longer held" });
            continue;
          }
          qty = Math.min(qty, pos.qty);
        } else if (p.role === "core") {
          // The core is exempt from the name and sector caps (it IS the diversified index); only the
          // cash floor applies, at today's prices.
          const cash = await this.broker.getCash();
          let equity = cash;
          for (const pos of await this.broker.getPositions()) {
            equity += pos.qty * (await this.marketData.getLatestPrice(pos.symbol).catch(() => pos.avgEntryPrice));
          }
          const spendable = cash - (equity * g.minCashFloorPct) / 100;
          const whole = this.broker.id !== "paper";
          const affordable = whole ? Math.floor(spendable / price) : Math.floor((spendable / price) * 1e4) / 1e4;
          if (affordable <= 0) {
            done({ status: "skipped", skipReason: `no cash above the ${g.minCashFloorPct}% floor after the other trades` });
            continue;
          }
          if (affordable < qty) {
            p.limitedBy = "cash available after the other trades";
            qty = affordable;
          }
        } else {
          const cash = await this.broker.getCash();
          const positionValues: Record<string, number> = {};
          for (const pos of await this.broker.getPositions()) {
            positionValues[pos.symbol] = pos.qty * (await this.marketData.getLatestPrice(pos.symbol).catch(() => pos.avgEntryPrice));
          }
          // Clamp to today's limits rather than refuse: a plan sized exactly at the 10% cap would
          // otherwise fail on any price uptick between planning and approval (seen live: NVDA).
          const bySector = sectorHeadroom(
            { sector: p.sector, cash, positionValues, sectorOf: (s) => sectorBySymbol.get(s) ?? null },
            { maxSectorPct: g.maxSectorPct },
          );
          const byName = maxBuyNotional({ symbol: p.symbol, cash, positionValues }, g);
          const allowed = Math.min(qty * price, byName, bySector);
          const whole = this.broker.id !== "paper";
          const fitted = whole ? Math.floor(allowed / price) : Math.floor((allowed / price) * 1e4) / 1e4;
          if (fitted <= 0) {
            done({
              status: "skipped",
              skipReason:
                bySector <= 0
                  ? `${p.sector} sector is at the ${g.maxSectorPct}% cap at today's prices`
                  : `no room under the ${g.maxPositionPct}% position cap and ${g.minCashFloorPct}% cash floor at today's prices`,
            });
            continue;
          }
          if (fitted < qty) {
            p.limitedBy = bySector < byName ? "sector cap at approval" : "position cap or cash floor at approval";
            qty = fitted;
          }
          const risk = checkRisk({ side: "buy", symbol: p.symbol, notional: qty * price, cash, positionValues }, g);
          if (!risk.ok) {
            done({ status: "skipped", skipReason: risk.reason });
            continue;
          }
        }
        const idempotencyKey = `agent:${run.id}:${p.id}`;
        const result = await this.broker.placeOrder({
          symbol: p.symbol,
          side: p.side,
          qtyOrNotional: String(qty),
          orderType: "limit",
          limitPrice: String(price),
          idempotencyKey,
        } as Parameters<IBroker["placeOrder"]>[0] & { symbol: string });
        await this.ledger?.record({
          id: idempotencyKey,
          ts: new Date().toISOString(),
          userId: actor.startsWith("user:") ? actor.slice(5) : actor,
          source: p.role === "core" ? "core" : "agent",
          symbol: p.symbol,
          side: p.side,
          qty: Number(result.filledQty) > 0 ? Number(result.filledQty) : qty,
          price: Number(result.filledAvgPrice) > 0 ? Number(result.filledAvgPrice) : price,
          status: result.status,
          brokerOrderId: result.brokerOrderId,
          runId: run.id,
        });
        done({
          status: result.status === "rejected" || result.status === "canceled" ? "failed" : "placed",
          qty, price, notional: qty * price, orderStatus: result.status, brokerOrderId: result.brokerOrderId, idempotencyKey,
          ...(result.status === "rejected" ? { skipReason: "broker rejected the order" } : {}),
        });
      } catch (e) {
        done({ status: "failed", skipReason: (e as Error).message });
      }
    }
    if (run.proposals.some((p) => p.status === "placed")) run.status = "executed";
    await this.runs.save(run);
  }

  /**
   * One-shot autonomous run (POST /agent/run and the scheduler). Plans, then executes every proposal
   * only when autonomous execution is permitted and no dry run was asked for.
   */
  async run(req: AgentRunRequest, trigger: AgentRun["trigger"] = "manual") {
    const gate = this.autonomousGate();
    const dryRun = !!req?.dryRun || !gate.ok;
    const run = await this.plan({ universe: req?.universe, trigger, satellitePct: req?.satellitePct });
    if (run.status !== "failed") {
      if (dryRun) {
        run.status = gate.ok ? "planned" : "blocked";
        run.note = gate.ok ? "dryRun requested" : gate.reason;
        await this.runs.save(run);
      } else {
        await this.execute(run, new Set(run.proposals.map((p) => p.id)), "agent:autonomous");
      }
    }
    return {
      runId: run.id,
      mode: run.mode,
      executed: !dryRun,
      reason: dryRun ? (gate.ok ? "dryRun requested" : gate.reason) : undefined,
      decisions: run.decisions.map(({ symbol, verdict, convictionScore }) => ({ symbol, verdict, convictionScore })),
      plan: {
        buys: run.proposals.filter((p) => p.side === "buy" && p.role !== "core").map((p) => p.symbol),
        sells: run.proposals.filter((p) => p.side === "sell" && p.role !== "core").map((p) => p.symbol),
        core: (() => {
          const c = run.proposals.find((p) => p.role === "core");
          return c ? { symbol: c.symbol, side: c.side, qty: c.qty, notional: c.notional } : null;
        })(),
      },
      orders: dryRun
        ? []
        : run.proposals.map((p) =>
            p.status === "placed" ? { symbol: p.symbol, side: p.side, qty: p.qty, status: p.orderStatus } : { symbol: p.symbol, side: p.side, skipped: p.skipReason },
          ),
      run,
    };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
