import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { FileAgentRunStore, InMemoryAgentRunStore, nextRunAt, parseCadence, parseTimeUtc, type AgentRun, type AgentRunStore, type DecisionService } from "@dipbuyer/agent";
import { attribute, performanceSeries, planCopy, weightsOf, type IBroker, type OrderResult, type Position } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import type { IntendedAction } from "@dipbuyer/shared";
import { AdminGuard } from "../auth/admin.guard.js";
import { Public } from "../auth/public.decorator.js";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { AgentModule } from "../agent/agent.module.js";
import { AgentService } from "../agent/agent.service.js";
import { DECISION_SERVICE } from "../decision/decision.providers.js";
import { DecisionModule } from "../decision/decision.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { BROKER } from "../orders/orders.providers.js";
import { MARKET_DATA } from "../orders/market-data.provider.js";
import { LEDGER_STORE, LedgerStore, SnapshotStore } from "../orders/portfolio.store.js";

/** Published model portfolios. Each is the live agent at one satellite share, run on its own simulated book. */
export const MODELS = [
  {
    id: "core-satellite",
    name: "Core + Lynch satellite",
    satellitePct: 30,
    description: "DipBuyer's default: 70% S&P 500 index core, up to 30% in Lynch buy-rated stocks.",
  },
  {
    id: "active",
    name: "Active Lynch",
    satellitePct: 70,
    description: "Up to 70% in Lynch picks. Bigger bets on the strategy, more tracking error against the index.",
  },
  {
    id: "index",
    name: "Index only",
    satellitePct: 0,
    description: "The benchmark: everything above the cash floor in the S&P 500 index. For comparison.",
  },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];
const INITIAL_CASH = 100_000;
const MIN_REBALANCE_GAP_MS = 20 * 3_600_000;

/**
 * A model's simulated brokerage book, saved to disk. Fills at the order's limit price, deduplicates
 * idempotency keys, rejects what it cannot afford or does not hold. `simulated` lets the agent execute
 * on it without the approval gates, which it refuses for any real or shared paper account.
 */
export class ModelBook implements IBroker {
  readonly id = "paper" as const;
  readonly simulated = true;
  private state: { cash: number; positions: Record<string, { qty: number; avgEntryPrice: number }>; seen: Record<string, OrderResult> };
  constructor(private readonly path?: string) {
    this.state = { cash: INITIAL_CASH, positions: {}, seen: {} };
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed.cash === "number") this.state = parsed;
    } catch {
      /* new book */
    }
  }
  private persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.state));
    renameSync(`${this.path}.tmp`, this.path);
  }
  async placeOrder(a: IntendedAction): Promise<OrderResult> {
    const prior = this.state.seen[a.idempotencyKey];
    if (prior) return prior;
    const symbol = (a as IntendedAction & { symbol?: string }).symbol ?? "UNKNOWN";
    const qty = Number(a.qtyOrNotional), price = Number(a.limitPrice);
    const pos = this.state.positions[symbol] ?? { qty: 0, avgEntryPrice: 0 };
    let ok = qty > 0 && price > 0;
    if (ok && a.side === "buy") {
      ok = qty * price <= this.state.cash + 1e-6;
      if (ok) {
        this.state.cash -= qty * price;
        pos.avgEntryPrice = (pos.qty * pos.avgEntryPrice + qty * price) / (pos.qty + qty);
        pos.qty += qty;
      }
    } else if (ok) {
      ok = pos.qty + 1e-9 >= qty;
      if (ok) {
        this.state.cash += qty * price;
        pos.qty = Math.max(0, pos.qty - qty);
      }
    }
    if (ok) {
      if (pos.qty > 1e-9) this.state.positions[symbol] = pos;
      else delete this.state.positions[symbol];
    }
    const result: OrderResult = { brokerOrderId: `model-${Object.keys(this.state.seen).length + 1}`, clientOrderId: a.idempotencyKey, status: ok ? "filled" : "rejected", filledQty: ok ? qty : 0, filledAvgPrice: ok ? price : undefined };
    this.state.seen[a.idempotencyKey] = result;
    this.persist();
    return result;
  }
  async getPositions(): Promise<Position[]> {
    return Object.entries(this.state.positions).map(([symbol, p]) => ({ symbol, qty: p.qty, avgEntryPrice: p.avgEntryPrice, marketValue: p.qty * p.avgEntryPrice, unrealizedPl: 0 }));
  }
  async getCash(): Promise<number> {
    return this.state.cash;
  }
}

class FollowStore {
  private rows: Array<{ userId: string; modelId: string; since: string }> = [];
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) this.rows = parsed;
    } catch {
      /* none yet */
    }
  }
  private persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.rows), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  followers(modelId: string) {
    return this.rows.filter((r) => r.modelId === modelId);
  }
  following(userId: string) {
    return this.rows.filter((r) => r.userId === userId).map((r) => r.modelId);
  }
  follow(userId: string, modelId: string) {
    if (!this.rows.some((r) => r.userId === userId && r.modelId === modelId)) this.rows.push({ userId, modelId, since: new Date().toISOString() });
    this.persist();
  }
  unfollow(userId: string, modelId: string) {
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.modelId === modelId));
    this.persist();
  }
}

interface ModelRuntime {
  def: (typeof MODELS)[number];
  book: ModelBook;
  runs: AgentRunStore;
  snapshots: SnapshotStore;
  agent: AgentService;
}

/** apps/api/.data/models unless MODELS_DIR is set. Set MODELS_DIR="" for in-memory (tests). */
const modelsDir = () => (process.env.MODELS_DIR !== undefined ? process.env.MODELS_DIR : fileURLToPath(new URL("../../.data/models", import.meta.url)));

@Injectable()
export class ModelsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("models");
  readonly models = new Map<string, ModelRuntime>();
  readonly follows: FollowStore;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DECISION_SERVICE) decisions: DecisionService,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataAdapter,
    @Inject(BROKER) private readonly account: IBroker,
    @Inject(LEDGER_STORE) private readonly ledger: LedgerStore,
    private readonly userAgent: AgentService,
  ) {
    const dir = modelsDir();
    const at = (f: string) => (dir ? join(dir, f) : undefined);
    this.follows = new FollowStore(at("follows.json"));
    for (const def of MODELS) {
      const book = new ModelBook(at(`${def.id}.book.json`));
      const runs = dir ? new FileAgentRunStore(join(dir, `${def.id}.runs.json`)) : new InMemoryAgentRunStore();
      this.models.set(def.id, { def, book, runs, snapshots: new SnapshotStore(at(`${def.id}.snapshots.json`)), agent: new AgentService(decisions, book, marketData, runs) });
    }
  }

  /** MODELS_SCHEDULE=daily|weekly (+ MODELS_TIME_UTC, default 21:30 after the US close): rebalance, then copy plans. Off by default. */
  onModuleInit() {
    const cadence = parseCadence(process.env.MODELS_SCHEDULE);
    if (cadence === "off") return;
    const arm = () => {
      const when = nextRunAt(cadence, parseTimeUtc(process.env.MODELS_TIME_UTC ?? "21:30"), new Date());
      if (!when) return;
      this.timer = setTimeout(async () => {
        if (Date.now() >= when.getTime() - 1_000) await this.rebalanceAll().catch((e) => this.log.error((e as Error).message));
        arm();
      }, Math.max(1_000, Math.min(when.getTime() - Date.now(), 24 * 3_600_000)));
    };
    arm();
  }
  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  get(id: string): ModelRuntime {
    const m = this.models.get(id);
    if (!m) throw new NotFoundException(`No model portfolio ${id}`);
    return m;
  }

  private async prices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const px = await this.marketData.getLatestPrice(s).catch(() => 0);
      if (px > 0) out[s] = px;
    }
    return out;
  }

  /** Mark a model to market, snapshot it (one per day), and describe it. */
  async view(id: string, userId?: string) {
    const m = this.get(id);
    const positions = await m.book.getPositions();
    const cash = await m.book.getCash();
    const px = await this.prices([...positions.map((p) => p.symbol), "SPY"]);
    const equity = cash + positions.reduce((t, p) => t + p.qty * (px[p.symbol] ?? p.avgEntryPrice), 0);
    const weights = weightsOf(positions, cash, px);
    const recent = await m.runs.recent(1);
    if (recent.length) {
      await m.snapshots.upsert({ date: new Date().toISOString().slice(0, 10), equity, cash, sleeves: {}, benchmark: px.SPY ?? null });
    }
    const snaps = (await m.snapshots.all()).sort((a, b) => (a.date < b.date ? -1 : 1));
    const series = performanceSeries(snaps);
    const last = series.at(-1);
    const runs = await m.runs.recent(10);
    return {
      id: m.def.id,
      name: m.def.name,
      description: m.def.description,
      satellitePct: m.def.satellitePct,
      inception: snaps[0]?.date ?? null,
      equity,
      cash,
      returnPct: last ? last.portfolio - 100 : null,
      benchmarkReturnPct: last?.benchmark !== null && last?.benchmark !== undefined ? last.benchmark - 100 : null,
      holdings: positions
        .map((p) => ({ symbol: p.symbol, qty: p.qty, price: px[p.symbol] ?? null, value: p.qty * (px[p.symbol] ?? p.avgEntryPrice), weight: weights[p.symbol] ?? 0, role: p.symbol === "SPY" ? "core" : "satellite" }))
        .sort((a, b) => b.value - a.value),
      lastRebalance: runs[0]?.finishedAt ?? null,
      trades: runs
        .flatMap((r) => r.proposals.filter((p) => p.status === "placed").map((p) => ({ at: p.decidedAt ?? r.finishedAt, side: p.side, symbol: p.symbol, qty: p.qty, price: p.price, reason: p.reason })))
        .slice(0, 20),
      series,
      followers: this.follows.followers(id).length,
      following: userId ? this.follows.following(userId).includes(id) : false,
    };
  }

  /** Run the agent on the model's own book at its satellite share and execute the plan there. */
  async rebalance(id: string, force = false) {
    const m = this.get(id);
    const last = (await m.runs.recent(1))[0];
    if (!force && last?.finishedAt && Date.now() - Date.parse(last.finishedAt) < MIN_REBALANCE_GAP_MS) {
      throw new BadRequestException(`${m.def.name} was rebalanced at ${last.finishedAt}; models rebalance at most once a day`);
    }
    const run = await m.agent.plan({ trigger: "schedule", satellitePct: m.def.satellitePct });
    if (run.status === "failed") throw new BadRequestException(`Rebalance failed: ${run.note}`);
    await m.agent.executeSimulated(run.id, `model:${id}`);
    return this.view(id);
  }

  /** Rebalance every model, then create a copy plan for each follower (they approve it on /agent). */
  async rebalanceAll() {
    for (const id of this.models.keys()) {
      await this.rebalance(id).catch((e) => this.log.warn(`${id}: ${(e as Error).message}`));
      for (const f of this.follows.followers(id)) await this.copyFor(f.userId, id).catch((e) => this.log.warn(`copy ${id} -> ${f.userId}: ${(e as Error).message}`));
    }
  }

  /**
   * A plan that brings the investor's account to the model's weights, leaving their own picks alone.
   * Stored as an ordinary agent run (trigger "copy") so it is reviewed and approved on /agent; nothing
   * is placed here.
   */
  async copyFor(userId: string, id: string): Promise<AgentRun> {
    const m = this.get(id);
    const modelPositions = await m.book.getPositions();
    if (!modelPositions.length) throw new BadRequestException(`${m.def.name} has no holdings yet; it starts at its first rebalance`);
    const account = (await this.account.getPositions()).filter((p) => p.qty > 0);
    const symbols = [...new Set([...modelPositions.map((p) => p.symbol), ...account.map((p) => p.symbol)])];
    const px = await this.prices(symbols);
    const weights = weightsOf(modelPositions, await m.book.getCash(), px);
    const attributed = attribute(await this.ledger.all(), account, (s) => px[s] ?? 0).bySymbol;
    const selfQty = (s: string) => (attributed[s] ?? []).filter((h) => h.sleeve === "self").reduce((t, h) => t + h.qty, 0);
    const { equity, trades } = planCopy({
      weights,
      positions: account.map((p) => ({ symbol: p.symbol, qty: p.qty, selfQty: selfQty(p.symbol) })),
      cash: await this.account.getCash(),
      prices: px,
      wholeShares: this.account.id !== "paper",
    });
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: randomUUID(),
      trigger: "copy",
      startedAt: now,
      finishedAt: now,
      mode: process.env.RUNTIME_MODE ?? "RESEARCH_ONLY",
      execution: process.env.RUNTIME_EXECUTION === "LIVE" ? "LIVE" : "PAPER",
      status: "planned",
      note: trades.length
        ? `Copy of the "${m.def.name}" model, sized to the ${Math.round(equity).toLocaleString("en-US")} dollars not in your own picks. Review and approve below.`
        : `Your account already matches the "${m.def.name}" model within 1%. Nothing to copy.`,
      universe: symbols,
      unavailable: symbols.filter((s) => !px[s]),
      decisions: [],
      sizing: null,
      proposals: trades.map((t) => ({
        id: randomUUID(),
        role: t.symbol === "SPY" ? ("core" as const) : ("satellite" as const),
        side: t.side,
        symbol: t.symbol,
        qty: t.qty,
        price: t.price,
        notional: t.notional,
        verdict: "copy",
        convictionScore: 0,
        lynchCategory: null,
        sector: null,
        decisionHash: null,
        reason: `Copy ${m.def.name}: ${(t.targetWeight * 100).toFixed(1)}% target, you hold ${(t.currentWeight * 100).toFixed(1)}%`,
        status: "proposed" as const,
      })),
    };
    return this.userAgent.savePlanned(run);
  }
}

/**
 * GET    /models                   all models with performance, holdings and whether you follow them
 * GET    /models/:id               one model in full (holdings, trades, performance series)
 * POST   /models/:id/follow        follow (copy plans arrive after each rebalance)
 * DELETE /models/:id/follow
 * POST   /models/:id/copy          a copy plan for your account now (approve it on /agent)
 * POST   /models/:id/rebalance     rebalance the model's simulated book (admin only, at most daily)
 */
@Controller("models")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  private uid(req?: AuthedRequest): string | undefined {
    try {
      return resolveUserId(req);
    } catch {
      return undefined; // anonymous visitors can still see the models
    }
  }

  /** Public: anyone may see the models and their record; following and copying need sign-in. */
  @Public()
  @Get()
  async list(@Req() req?: AuthedRequest) {
    const userId = this.uid(req);
    return Promise.all([...this.models.models.keys()].map((id) => this.models.view(id, userId)));
  }

  @Public()
  @Get(":id")
  view(@Param("id") id: string, @Req() req?: AuthedRequest) {
    return this.models.view(id, this.uid(req));
  }

  @Post(":id/follow")
  follow(@Param("id") id: string, @Req() req?: AuthedRequest) {
    this.models.get(id);
    this.models.follows.follow(resolveUserId(req), id);
    return { following: true };
  }

  @Delete(":id/follow")
  unfollow(@Param("id") id: string, @Req() req?: AuthedRequest) {
    this.models.follows.unfollow(resolveUserId(req), id);
    return { following: false };
  }

  @Post(":id/copy")
  copy(@Param("id") id: string, @Req() req?: AuthedRequest) {
    return this.models.copyFor(resolveUserId(req), id);
  }

  @UseGuards(AdminGuard)
  @Post(":id/rebalance")
  rebalance(@Param("id") id: string) {
    return this.models.rebalance(id);
  }
}

@Module({
  imports: [DecisionModule, OrdersModule, AgentModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
