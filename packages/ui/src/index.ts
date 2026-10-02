/**
 * Shared design tokens + component library (see DESIGN.md). Verdict colors are FIXED across
 * themes; everything else is white-label overridable per Tenant via CSS variables.
 */
export const verdictColors = {
  buy: "var(--success)",
  hold: "var(--warning)",
  trim: "var(--warning)",
  sell: "var(--danger)",
  avoid: "var(--danger)",
  abstain: "var(--neutral)",
} as const;

export const tokens = {
  radius: { input: "12px", button: "8px", pill: "9999px" },
  motion: { ui: "200ms ease-out" },
} as const;

// TODO(phase-1): VerdictBadge, ConvictionGauge, CriteriaChecklist, DecisionCard,
// ProvenanceChip, OnChainBadge, DisclaimerBanner (shadcn/ui wrapped with tokens).
export {};
