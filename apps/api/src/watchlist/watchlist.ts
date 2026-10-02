import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { loadInsiderPurchases } from "../research/insiders.js";
import { RESEARCH_SERVICE } from "../research/research.providers.js";
import { ResearchModule } from "../research/research.module.js";
import type { ResearchService } from "../research/research.service.js";
import { DEFAULT_RULES, detectAlerts, type AlertKind, type AlertRules, type StockState } from "./alerts.js";

export interface WatchItem {
  userId: string;
  symbol: string;
  rules: AlertRules;
  addedAt: string;
  state: StockState | null;
  checkedAt: string | null;
}

export interface AlertEvent {
  id: string;
  userId: string;
  symbol: string;
  kind: AlertKind;
  message: string;
  at: string;
  read: boolean;
}

/** Watchlists and alert history. In memory unless WATCHLIST_PATH is set (atomic JSON, 0600). */
export class WatchlistStore {
  private data: { items: WatchItem[]; alerts: AlertEvent[] } = { items: [], alerts: [] };
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && Array.isArray(parsed.items) && Array.isArray(parsed.alerts)) this.data = parsed;
    } catch {
      /* no file yet */
    }
  }
  private persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  items(userId?: string): WatchItem[] {
    return this.data.items.filter((i) => userId === undefined || i.userId === userId);
  }
  upsert(item: WatchItem) {
    const i = this.data.items.findIndex((x) => x.userId === item.userId && x.symbol === item.symbol);
    if (i >= 0) this.data.items[i] = item;
    else this.data.items.push(item);
    this.persist();
  }
  remove(userId: string, symbol: string): boolean {
    const n = this.data.items.length;
    this.data.items = this.data.items.filter((x) => !(x.userId === userId && x.symbol === symbol));
    this.persist();
    return this.data.items.length < n;
  }
  addAlert(a: AlertEvent) {
    this.data.alerts.unshift(a);
    if (this.data.alerts.length > 5_000) this.data.alerts.length = 5_000;
    this.persist();
  }
  alerts(userId: string): AlertEvent[] {
    return this.data.alerts.filter((a) => a.userId === userId);
  }
  markRead(userId: string) {
    for (const a of this.data.alerts) if (a.userId === userId) a.read = true;
    this.persist();
  }
}

export const WATCHLIST_STORE = "WATCHLIST_STORE";
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const CHECK_EVERY_MS = 60 * 60_000;
const fmtUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

@Injectable()
export class WatchlistService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(WATCHLIST_STORE) readonly store: WatchlistStore,
    @Inject(RESEARCH_SERVICE) private readonly research: ResearchService,
  ) {}

  /** WATCHLIST_CHECK_HOURS=6 also checks in the background; otherwise checks happen when a list is read. */
  onModuleInit() {
    const h = Number(process.env.WATCHLIST_CHECK_HOURS);
    if (h > 0) this.timer = setInterval(() => void this.check(), h * 3_600_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Current state of one stock: verdict and price from research, latest >= $10k insider buy from Form 4. */
  async stateOf(symbol: string): Promise<StockState> {
    const view = await this.research.view(symbol);
    const rec = view.decision.record;
    const buys = loadInsiderPurchases().rows.filter((r) => r.ticker === symbol);
    const byFiling = new Map<string, { filed: string; usd: number; insider: string; title: string }>();
    for (const r of buys) {
      const f = byFiling.get(r.accession) ?? { filed: r.filed, usd: 0, insider: r.insider, title: r.title };
      f.usd += r.usd;
      byFiling.set(r.accession, f);
    }
    const latest = [...byFiling.values()].filter((f) => f.usd >= 10_000).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
    return {
      verdict: rec.verdict ?? null,
      convictionScore: rec.convictionScore ?? null,
      price: view.price?.price ?? null,
      drawdown: view.price?.drawdown ?? null,
      lastInsiderFiled: latest?.filed ?? null,
      lastInsiderSummary: latest ? `${latest.insider} (${latest.title}) bought ${fmtUsd(latest.usd)}, filed ${latest.filed}` : null,
    };
  }

  /** Re-check items (all, or one user's) and record alerts for changes. One check at a time. */
  async check(userId?: string, force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const due = this.store.items(userId).filter((i) => force || !i.checkedAt || Date.now() - Date.parse(i.checkedAt) > CHECK_EVERY_MS);
      const states = new Map<string, StockState | null>();
      for (const sym of [...new Set(due.map((i) => i.symbol))]) {
        states.set(sym, await this.stateOf(sym).catch(() => null)); // a failed lookup keeps the old state
      }
      for (const item of due) {
        const now = states.get(item.symbol);
        if (!now) continue;
        for (const a of detectAlerts(item.symbol, item.rules, item.state, now)) {
          this.store.addAlert({ id: randomUUID(), userId: item.userId, symbol: item.symbol, kind: a.kind, message: a.message, at: new Date().toISOString(), read: false });
        }
        this.store.upsert({ ...item, state: now, checkedAt: new Date().toISOString() });
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

function rulesFrom(body: Partial<AlertRules> | undefined, base: AlertRules): AlertRules {
  const dip = body?.dipPct === undefined ? base.dipPct : body.dipPct === null ? null : Number(body.dipPct);
  if (dip !== null && !(dip > 0 && dip < 100)) throw new BadRequestException("dipPct must be between 0 and 100, or null");
  return { buy: body?.buy ?? base.buy, dipPct: dip, insider: body?.insider ?? base.insider };
}

/**
 * GET    /watchlist                 your stocks with their current state + unread alert count
 * PUT    /watchlist/:symbol         add or update { buy?, dipPct?, insider? }
 * DELETE /watchlist/:symbol
 * GET    /watchlist/symbols         your symbols + unread count (no re-check)
 * GET    /watchlist/alerts          your alerts, newest first
 * POST   /watchlist/alerts/read     mark all read
 * POST   /watchlist/check           re-check now
 */
@Controller("watchlist")
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  async list(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    await this.watchlist.check(userId);
    return {
      items: this.watchlist.store.items(userId).sort((a, b) => a.symbol.localeCompare(b.symbol)),
      unread: this.watchlist.store.alerts(userId).filter((a) => !a.read).length,
    };
  }

  @Put(":symbol")
  async add(@Param("symbol") symbol: string, @Body() body: Partial<AlertRules>, @Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    const s = symbol.toUpperCase();
    if (!SYMBOL.test(s)) throw new BadRequestException("Invalid symbol");
    const existing = this.watchlist.store.items(userId).find((i) => i.symbol === s);
    const item: WatchItem = existing
      ? { ...existing, rules: rulesFrom(body, existing.rules) }
      : { userId, symbol: s, rules: rulesFrom(body, DEFAULT_RULES), addedAt: new Date().toISOString(), state: null, checkedAt: null };
    this.watchlist.store.upsert(item);
    if (!existing) await this.watchlist.check(userId); // baseline now, so the first real change alerts
    return this.watchlist.store.items(userId).find((i) => i.symbol === s);
  }

  @Delete(":symbol")
  remove(@Param("symbol") symbol: string, @Req() req?: AuthedRequest) {
    if (!this.watchlist.store.remove(resolveUserId(req), symbol.toUpperCase())) throw new NotFoundException(`${symbol} is not on your watchlist`);
    return { removed: symbol.toUpperCase() };
  }

  /** Cheap: symbols and unread count, no re-check (the header polls this). */
  @Get("symbols")
  symbols(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    return {
      symbols: this.watchlist.store.items(userId).map((i) => i.symbol),
      unread: this.watchlist.store.alerts(userId).filter((a) => !a.read).length,
    };
  }

  @Get("alerts")
  alerts(@Req() req?: AuthedRequest) {
    return this.watchlist.store.alerts(resolveUserId(req));
  }

  @Post("alerts/read")
  read(@Req() req?: AuthedRequest) {
    this.watchlist.store.markRead(resolveUserId(req));
    return { ok: true };
  }

  @Post("check")
  async checkNow(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    await this.watchlist.check(userId, true);
    return { items: this.watchlist.store.items(userId), unread: this.watchlist.store.alerts(userId).filter((a) => !a.read).length };
  }
}

@Module({
  imports: [ResearchModule],
  controllers: [WatchlistController],
  providers: [
    WatchlistService,
    { provide: WATCHLIST_STORE, useFactory: () => new WatchlistStore(process.env.WATCHLIST_PATH || undefined) },
  ],
  exports: [WatchlistService],
})
export class WatchlistModule {}
