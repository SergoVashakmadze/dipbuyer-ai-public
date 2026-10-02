import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { AgentScheduler } from "./agent.scheduler.js";
import { AgentService, type AgentRunRequest, type ApproveRequest } from "./agent.service.js";

/**
 * Investing agent. Protected by the global AuthGuard when Auth0 is configured.
 *   GET  /agent/status                 mode, gates, guardrails, schedule
 *   POST /agent/plan  { universe?, satellitePct? }  screen + propose trades (never places orders)
 *   POST /agent/runs/:id/approve       { proposalIds, userId } place selected proposals
 *   GET  /agent/runs, /agent/runs/:id  run history
 *   POST /agent/run   { universe?, dryRun? }  one-shot autonomous run (DISCRETIONARY only executes)
 */
@Controller("agent")
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly scheduler: AgentScheduler,
  ) {}

  @Get("status")
  status() {
    return { ...this.agent.status(), schedule: this.scheduler.state() };
  }

  @Post("plan")
  plan(@Body() body: { universe?: string[]; satellitePct?: number }) {
    const pct = body?.satellitePct;
    return this.agent.plan({ universe: body?.universe, trigger: "manual", satellitePct: pct === undefined || pct === null ? undefined : Number(pct) });
  }

  @Get("runs")
  runs(@Query("limit") limit?: string) {
    return this.agent.listRuns(Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  @Get("runs/:id")
  run(@Param("id") id: string) {
    return this.agent.getRun(id);
  }

  @Post("runs/:id/approve")
  approve(@Param("id") id: string, @Body() body: ApproveRequest, @Req() req?: AuthedRequest) {
    return this.agent.approve(id, { ...body, userId: resolveUserId(req, body?.userId) });
  }

  @Post("run")
  async runNow(@Body() body: AgentRunRequest) {
    return this.agent.run(body ?? {});
  }
}
