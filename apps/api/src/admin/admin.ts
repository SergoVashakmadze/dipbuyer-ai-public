import { Controller, Get, Inject, Module, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { AgentRunStore } from "@dipbuyer/agent";
import type { IBroker } from "@dipbuyer/brokers";
import { loadStrategyConfig } from "@dipbuyer/strategy";
import { AdminGuard, adminDecision } from "../auth/admin.guard.js";
import type { AuthedRequest } from "../auth/identity.js";
import { AgentModule } from "../agent/agent.module.js";
import { AGENT_RUN_STORE } from "../agent/agent.service.js";
import { DigestModule, DigestService, EMAIL_SENDER, type EmailSender } from "../digest/digest.js";
import { INVESTOR_STORE, InvestorStore } from "../investors/investor.store.js";
import { ModelsModule, ModelsService } from "../models/models.js";
import { OrdersModule } from "../orders/orders.module.js";
import { BROKER } from "../orders/orders.providers.js";
import { loadInsiderPurchases } from "../research/insiders.js";
import { InsiderRefresher } from "../research/insider-refresh.js";
import { ResearchModule } from "../research/research.module.js";

/**
 * Operator console. Everything except /admin/whoami requires AdminGuard (ADMIN_SUBJECTS).
 *   GET  /admin/whoami                   your verified subject and whether you are admin (to configure it)
 *   GET  /admin/overview                 runtime, schedules, data freshness, investors, models, agent
 *   POST /admin/models/:id/rebalance     rebalance one model now
 *   POST /admin/models/rebalance-all     rebalance every model and create follower copy plans
 *   POST /admin/digest/send-all          send the weekly digest to opted-in investors now
 *   POST /admin/insiders/refresh         refresh the SEC Form 4 insider data now (background)
 */
@Controller("admin")
export class AdminController {
  constructor(
    @Inject(INVESTOR_STORE) private readonly investors: InvestorStore,
    @Inject(BROKER) private readonly broker: IBroker,
    @Inject(AGENT_RUN_STORE) private readonly runs: AgentRunStore,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly models: ModelsService,
    private readonly digest: DigestService,
    private readonly insiderRefresh: InsiderRefresher,
  ) {}

  @Get("whoami")
  whoami(@Req() req?: AuthedRequest) {
    const d = adminDecision(req);
    return { subject: req?.user?.sub ?? null, admin: d.admin, reason: d.reason };
  }

  @UseGuards(AdminGuard)
  @Get("overview")
  async overview() {
    const env = process.env;
    const investors = this.investors.all();
    const insider = loadInsiderPurchases();
    const week = Date.now() - 7 * 86_400_000;
    const runs = await this.runs.recent(200);
    return {
      runtime: {
        mode: env.RUNTIME_MODE ?? "RESEARCH_ONLY",
        execution: env.RUNTIME_EXECUTION === "LIVE" ? "LIVE" : "PAPER",
        liveTradingEnabled: env.LIVE_TRADING_ENABLED === "true",
        halted: env.RUNTIME_HALT === "true",
        broker: this.broker.id ?? "unknown",
        strategyVersion: loadStrategyConfig().config.version,
      },
      schedules: {
        agent: env.AGENT_SCHEDULE ?? "off",
        agentAutoExecute: env.AGENT_SCHEDULE_AUTO_EXECUTE === "true",
        models: env.MODELS_SCHEDULE ?? "off",
        digest: env.DIGEST_SCHEDULE ?? "off",
        watchlistCheckHours: env.WATCHLIST_CHECK_HOURS ?? "on read only",
        emailProvider: this.email.id,
      },
      data: {
        insiderUpdatedAt: insider.updatedAt,
        insiderPurchases: insider.rows.length,
        insiderLatestFiling: insider.rows.reduce<string | null>((m, r) => (!m || r.filed > m ? r.filed : m), null),
        insiderRefresh: env.INSIDER_REFRESH ?? "off",
        insiderRefreshRunning: this.insiderRefresh.inProgress,
        insiderLastRefresh: this.insiderRefresh.lastRun,
      },
      investors: {
        total: investors.length,
        onboarded: investors.filter((i) => i.kyc?.status === "VALID" && i.suitability?.status === "VALID").length,
        unsuitable: investors.filter((i) => i.suitability?.status === "UNSUITABLE").length,
        digestOptIns: investors.filter((i) => i.digest?.optIn).length,
        recent: investors
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, 50)
          .map((i) => ({
            userId: i.userId,
            email: i.email,
            name: i.profile?.fullName ?? null,
            kyc: i.kyc?.status ?? null,
            kycDemo: i.kyc?.demo ?? null,
            suitability: i.suitability?.status ?? null,
            digest: i.digest?.optIn ?? false,
            createdAt: i.createdAt,
          })),
      },
      models: await Promise.all(
        [...this.models.models.keys()].map(async (id) => {
          const v = await this.models.view(id);
          return { id, name: v.name, equity: v.equity, returnPct: v.returnPct, benchmarkReturnPct: v.benchmarkReturnPct, followers: v.followers, lastRebalance: v.lastRebalance };
        }),
      ),
      agent: {
        runsThisWeek: runs.filter((r) => Date.parse(r.startedAt) >= week).length,
        copyPlansThisWeek: runs.filter((r) => r.trigger === "copy" && Date.parse(r.startedAt) >= week).length,
        ordersPlacedThisWeek: runs.filter((r) => Date.parse(r.startedAt) >= week).reduce((t, r) => t + r.proposals.filter((p) => p.status === "placed").length, 0),
      },
    };
  }

  @UseGuards(AdminGuard)
  @Post("models/:id/rebalance")
  rebalance(@Param("id") id: string) {
    return this.models.rebalance(id, true);
  }

  @UseGuards(AdminGuard)
  @Post("models/rebalance-all")
  async rebalanceAll() {
    await this.models.rebalanceAll();
    return { ok: true };
  }

  /** Starts the SEC Form 4 refresh in the background (a daily run takes a few minutes). */
  @UseGuards(AdminGuard)
  @Post("insiders/refresh")
  refreshInsiders() {
    const already = this.insiderRefresh.inProgress;
    void this.insiderRefresh.refresh();
    return { started: !already, running: true };
  }

  @UseGuards(AdminGuard)
  @Post("digest/send-all")
  sendAll() {
    return this.digest.sendAll();
  }
}

@Module({
  imports: [OrdersModule, AgentModule, ModelsModule, DigestModule, ResearchModule],
  controllers: [AdminController],
})
export class AdminModule {}
