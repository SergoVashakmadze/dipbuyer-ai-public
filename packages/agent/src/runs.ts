import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Agent run records: what the agent screened, what it proposed, what a human approved, and what
 * the broker did. Decisions are already stored immutably (DecisionStore); a run ties a batch of them
 * to the trades that followed, which is what an auditor asks for ("why did this order happen?").
 */
export type ProposalStatus = "proposed" | "placed" | "skipped" | "failed";

export interface TradeProposal {
  id: string;
  side: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
  notional: number;
  verdict: string;
  convictionScore: number;
  lynchCategory: string | null;
  sector: string | null;
  decisionHash: string | null;
  /** Why the agent proposes this trade, in plain English. */
  reason: string;
  status: ProposalStatus;
  /** Why nothing was (or could be) placed. */
  skipReason?: string;
  limitedBy?: string;
  orderStatus?: string;
  brokerOrderId?: string;
  idempotencyKey?: string;
  decidedAt?: string;
  decidedBy?: string;
  /** "core" = the index ETF allocation; absent or "satellite" = a Lynch pick. */
  role?: "core" | "satellite";
}

export interface AgentRun {
  id: string;
  /** "copy" = a plan copying a model portfolio into a follower's account (awaits their approval). */
  trigger: "manual" | "schedule" | "copy";
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  execution: string;
  /** planned: awaiting review · executed: orders sent · blocked: execution not permitted · failed. */
  status: "planned" | "executed" | "blocked" | "failed";
  note?: string;
  universe: string[];
  unavailable: string[];
  decisions: Array<{ symbol: string; verdict: string; convictionScore: number; lynchCategory: string | null; hash: string | null }>;
  sizing: { equity: number; cash: number; intendedPositions: number; equalWeight: number } | null;
  /** Core + satellite split this run planned against (absent on runs before 2026-09-18). */
  allocation?: {
    coreSymbol: string;
    satellitePct: number;
    totalEquity: number;
    coreValue: number;
    satelliteValue: number;
    satelliteBudget: number;
    coreTarget: number | null;
  };
  proposals: TradeProposal[];
}

export interface AgentRunStore {
  save(run: AgentRun): Promise<void>;
  get(id: string): Promise<AgentRun | null>;
  recent(limit?: number): Promise<AgentRun[]>;
}

const MAX_RUNS = 500;

export class InMemoryAgentRunStore implements AgentRunStore {
  protected runs: AgentRun[] = [];
  async save(run: AgentRun): Promise<void> {
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.runs[i] = structuredClone(run);
    else this.runs.unshift(structuredClone(run));
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    this.persist();
  }
  async get(id: string): Promise<AgentRun | null> {
    const r = this.runs.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }
  async recent(limit = 20): Promise<AgentRun[]> {
    return this.runs.slice(0, limit).map((r) => structuredClone(r));
  }
  protected persist(): void {}
}

/**
 * JSON-file store so runs survive an API restart without a database (AGENT_RUNS_PATH). Writes go to
 * a temp file then rename, so a crash mid-write cannot leave a half-written history.
 */
export class FileAgentRunStore extends InMemoryAgentRunStore {
  constructor(private readonly path: string) {
    super();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) this.runs = parsed as AgentRun[];
    } catch {
      this.runs = []; // no file yet, or unreadable: start empty rather than refuse to boot
    }
  }
  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.runs));
    renameSync(tmp, this.path);
  }
}
