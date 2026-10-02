import type { Criterion, LynchCategory, Understandability, Verdict } from "./lynch.js";

export type RuntimeMode = "RESEARCH_ONLY" | "ADVISORY" | "DISCRETIONARY";
export type Execution = "PAPER" | "LIVE";

export interface DataProvenance {
  field: string;
  source: string; // e.g. "alpaca", "financialdatasets.ai"
  asOf: string; // ISO-8601
}

export interface IntendedAction {
  side: "buy" | "sell";
  qtyOrNotional: string;
  orderType: "market" | "limit" | "stop" | "bracket";
  limitPrice?: string;
  idempotencyKey: string;
}

export type RiskCheckMap = Record<string, "pass" | "fail" | "na">;

export interface ModelInfo {
  promptVersion: string;
  modelId: string;
  /** Hash of config/strategy.lynch.json used for this decision. */
  strategyConfigHash: string;
}

/**
 * The audit primitive. EVERY analysis/action emits exactly one of these, persisted
 * immutably and (optionally) hash-anchored on Algorand. No record → no action.
 * See PROMPT.md §7 and the engineering design notes
 */
export interface DecisionRecord {
  decisionId: string;
  ts: string; // ISO-8601 (runtime.as_of — simulated clock in backtest)
  mode: RuntimeMode;
  execution: Execution;
  clientId: string | null;
  tenantId: string | null;
  symbol: string;
  lynchCategory: LynchCategory | null;
  understandability: Understandability;
  criteria: Criterion[];
  convictionScore: number; // 0..100, reconstructible from `criteria`
  verdict: Verdict;
  rationale: string;
  sellTriggers: string[];
  riskChecks: RiskCheckMap;
  intendedAction: IntendedAction | null;
  dataProvenance: DataProvenance[];
  model: ModelInfo;
  confidence: number; // 0..1
  abstainReason: string | null;
  disclaimers: string[];
  /** Set once anchored on-chain. */
  chainAnchorTxid?: string;
}
