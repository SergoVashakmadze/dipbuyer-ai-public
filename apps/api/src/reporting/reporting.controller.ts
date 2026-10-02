import { Controller, Get, Inject } from "@nestjs/common";
import type { DecisionStore } from "@dipbuyer/agent";
import { loadStrategyConfig } from "@dipbuyer/strategy";
import { DECISION_STORE } from "../decision/decision.providers.js";

/**
 * Regulator / partner / investor facing reporting. Produces an audit-pack summary bundling the
 * decision history, methodology config hash (reproducibility), and operating posture — the kind
 * of evidence FCA model-governance expects (research brief §3.13). Protected when Auth0 is set.
 */
@Controller("reports")
export class ReportingController {
  constructor(@Inject(DECISION_STORE) private readonly store: DecisionStore) {}

  @Get("audit")
  async audit() {
    const decisions = await this.store.recent(1000);
    const byVerdict: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const d of decisions) {
      byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1;
      const cat = d.lynchCategory ?? "unknown";
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }
    const { config, hash } = loadStrategyConfig();
    return {
      generatedAt: new Date().toISOString(),
      methodology: "Peter Lynch (PEG/GARP, six categories, invest-in-what-you-know)",
      strategyConfigVersion: config.version,
      strategyConfigHash: hash,
      mode: process.env.RUNTIME_MODE ?? "RESEARCH_ONLY",
      execution: process.env.RUNTIME_EXECUTION ?? "PAPER",
      totalDecisions: decisions.length,
      byVerdict,
      byCategory,
      note: "Each decision is an immutable, hash-anchorable record. Past performance is not a guide to future results.",
    };
  }
}
