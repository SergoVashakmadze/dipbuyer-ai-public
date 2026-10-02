import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { INVESTOR_STORE, InvestorStore, type SuitabilityState } from "../investors/investor.store.js";

/**
 * Suitability assessment (COBS 9A). Captures what a suitable advice or discretionary decision
 * legally requires and decides whether this service (a concentrated US large-cap equity strategy,
 * where losses are possible and backtested drawdowns reached 22%) is suitable. An UNSUITABLE
 * outcome is recorded as evidence and blocks trading; it is not an error.
 */
export interface SuitabilityInput {
  userId: string;
  objectives: string;
  riskTolerance: SuitabilityState["riskTolerance"];
  capacityForLoss: SuitabilityState["capacityForLoss"];
  knowledgeExperience: SuitabilityState["knowledgeExperience"];
  /** Older clients did not send this; treated as "5to10". */
  investmentHorizon?: SuitabilityState["investmentHorizon"];
  exclusions?: string[];
  /** Required when warningsFor() returns anything: the investor ticked "I understand". */
  riskAcknowledged?: boolean;
}

export type SuitabilityRecord = SuitabilityState & { userId: string };

const ONE_OF = {
  riskTolerance: ["low", "medium", "high"],
  capacityForLoss: ["low", "medium", "high"],
  knowledgeExperience: ["none", "basic", "informed", "expert"],
  investmentHorizon: ["lt3", "3to5", "5to10", "gt10"],
} as const;

/** Plain-English reasons the equity strategy is not suitable; empty = suitable. */
export function unsuitableReasons(i: Required<Pick<SuitabilityInput, "riskTolerance" | "capacityForLoss" | "knowledgeExperience" | "investmentHorizon">>): string[] {
  const reasons: string[] = [];
  if (i.capacityForLoss === "low") reasons.push("You told us you could not afford to lose part of this money. Equity investments can fall sharply.");
  if (i.investmentHorizon === "lt3") reasons.push("You may need the money within three years. Shares can take years to recover from a fall.");
  if (i.knowledgeExperience === "none") reasons.push("You have no investment knowledge or experience yet. Start with our research and education first.");
  return reasons;
}

/**
 * Risks that do not block but must be explicitly acknowledged (owner decision 2026-09-17: warn, don't
 * block, on attitude to risk; block only on facts about capacity, horizon and experience).
 */
export function warningsFor(i: Pick<SuitabilityInput, "riskTolerance">): string[] {
  return i.riskTolerance === "low"
    ? ["You said you would sell after a 20% fall. This strategy's value fell 22% at its worst in the 2016-2025 backtest, and selling after a fall locks in the loss."]
    : [];
}

@Injectable()
export class SuitabilityService {
  private readonly store: InvestorStore;

  constructor(@Optional() @Inject(INVESTOR_STORE) store?: InvestorStore) {
    this.store = store ?? new InvestorStore();
  }

  assess(input: SuitabilityInput): SuitabilityRecord {
    for (const [k, allowed] of Object.entries(ONE_OF)) {
      const v = (input as unknown as Record<string, unknown>)[k];
      if (v !== undefined && !(allowed as readonly string[]).includes(String(v))) throw new BadRequestException(`${k} must be one of ${allowed.join(", ")}`);
    }
    const investmentHorizon = input.investmentHorizon ?? "5to10";
    const reasons = unsuitableReasons({ ...input, investmentHorizon });
    const warnings = reasons.length ? [] : warningsFor(input);
    if (warnings.length && !input.riskAcknowledged) throw new BadRequestException("Please confirm you understand the risk before continuing");
    const state: SuitabilityState = {
      objectives: input.objectives ?? "",
      riskTolerance: input.riskTolerance,
      capacityForLoss: input.capacityForLoss,
      knowledgeExperience: input.knowledgeExperience,
      investmentHorizon,
      exclusions: input.exclusions ?? [],
      status: reasons.length ? "UNSUITABLE" : "VALID",
      reasons,
      warnings,
      riskAcknowledgedAt: warnings.length ? new Date().toISOString() : null,
      assessedAt: new Date().toISOString(),
    };
    this.store.update(input.userId, (r) => {
      r.suitability = state;
    });
    return { userId: input.userId, ...state };
  }

  get(userId: string): SuitabilityRecord | null {
    const s = this.store.get(userId)?.suitability;
    return s ? { userId, ...s } : null;
  }

  /** Whether a user may receive advice / discretionary management. */
  isValid(userId: string): boolean {
    return this.store.get(userId)?.suitability?.status === "VALID";
  }
}
