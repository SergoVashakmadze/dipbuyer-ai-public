import type { DataProvenance, DecisionRecord, Execution, RuntimeMode, Understandability } from "@dipbuyer/shared";
import type { EvaluateResult } from "./engine.js";

export interface RecordContext {
  decisionId: string;
  ts: string; // runtime.as_of (simulated clock in backtest)
  mode: RuntimeMode;
  execution: Execution;
  clientId?: string | null;
  tenantId?: string | null;
  modelId: string;
  promptVersion: string;
  understandability: Understandability;
  dataProvenance?: DataProvenance[];
  rationale?: string;
  confidence?: number;
}

/**
 * Converts the deterministic engine output into a complete, audit-ready DecisionRecord
 * (PROMPT.md §7). The score MUST stay reconstructible from `criteria`, so we pass the
 * engine's checklist through verbatim. Hash with @dipbuyer/chain.hashDecision and anchor.
 */
export function buildDecisionRecord(result: EvaluateResult, ctx: RecordContext): DecisionRecord {
  const abstaining = result.verdict === "abstain";
  return {
    decisionId: ctx.decisionId,
    ts: ctx.ts,
    mode: ctx.mode,
    execution: ctx.execution,
    clientId: ctx.clientId ?? null,
    tenantId: ctx.tenantId ?? null,
    symbol: result.symbol,
    lynchCategory: result.category,
    understandability: ctx.understandability,
    criteria: result.checklist,
    convictionScore: result.convictionScore,
    verdict: result.verdict,
    rationale: ctx.rationale ?? `${result.category}: ${result.categoryReason} → ${result.verdict} (score ${result.convictionScore})`,
    sellTriggers: result.sellTriggers,
    riskChecks: {},
    intendedAction: null,
    dataProvenance: ctx.dataProvenance ?? [],
    model: { promptVersion: ctx.promptVersion, modelId: ctx.modelId, strategyConfigHash: result.strategyConfigHash },
    confidence: ctx.confidence ?? (abstaining ? 0 : result.convictionScore / 100),
    abstainReason: abstaining ? result.categoryReason : null,
    disclaimers: ["Past performance is not a guide to future results.", "Capital at risk."],
  };
}
