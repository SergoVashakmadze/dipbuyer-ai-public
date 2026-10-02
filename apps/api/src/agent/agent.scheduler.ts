import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { nextRunAt, parseCadence, parseTimeUtc, type ScheduleCadence } from "@dipbuyer/agent";
import { AgentService } from "./agent.service.js";

/** setTimeout cannot wait longer than ~24.8 days; wake at least daily and re-check. */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Optional scheduled agent. OFF unless AGENT_SCHEDULE is daily, weekly or monthly. A scheduled run
 * only PLANS by default: its proposals wait on the Agent page for a person to approve. It executes
 * on its own only when AGENT_SCHEDULE_AUTO_EXECUTE=true AND the API is in DISCRETIONARY mode (and the
 * usual halt / live-trading gates pass). Configuration is by environment on purpose: switching an
 * autonomous trading loop on should be a deployment decision, not a button.
 */
@Injectable()
export class AgentScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("AgentScheduler");
  private timer: NodeJS.Timeout | null = null;
  private next: Date | null = null;
  private last: { at: string; runId: string | null; outcome: string } | null = null;
  private running = false;

  constructor(private readonly agent: AgentService) {}

  cadence(): ScheduleCadence {
    return parseCadence(process.env.AGENT_SCHEDULE);
  }

  autoExecute(): boolean {
    return process.env.AGENT_SCHEDULE_AUTO_EXECUTE === "true";
  }

  state() {
    const cadence = this.cadence();
    return {
      cadence,
      timeUtc: process.env.AGENT_SCHEDULE_TIME_UTC ?? "21:30",
      autoExecute: this.autoExecute(),
      willExecute: this.autoExecute() && this.agent.autonomousGate().ok,
      nextRunAt: this.next?.toISOString() ?? null,
      lastRun: this.last,
      running: this.running,
    };
  }

  onModuleInit() {
    this.arm();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.next = nextRunAt(this.cadence(), parseTimeUtc(process.env.AGENT_SCHEDULE_TIME_UTC), new Date());
    if (!this.next) return;
    const wait = Math.max(1000, this.next.getTime() - Date.now());
    this.timer = setTimeout(() => void (wait > MAX_WAIT_MS ? this.arm() : this.fire()), Math.min(wait, MAX_WAIT_MS));
    this.timer.unref?.();
    this.log.log(`next ${this.cadence()} agent run at ${this.next.toISOString()} (${this.autoExecute() ? "auto-execute if permitted" : "plan only"})`);
  }

  async fire() {
    if (this.running) return;
    this.running = true;
    try {
      const out = await this.agent.run({ dryRun: !this.autoExecute() }, "schedule");
      this.last = { at: new Date().toISOString(), runId: out.runId, outcome: out.executed ? "executed" : out.reason ?? "planned" };
    } catch (e) {
      this.last = { at: new Date().toISOString(), runId: null, outcome: `failed: ${(e as Error).message}` };
      this.log.error(`scheduled agent run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
      this.arm();
    }
  }
}
