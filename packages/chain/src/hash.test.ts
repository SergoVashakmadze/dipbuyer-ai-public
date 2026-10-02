import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "@dipbuyer/shared";
import { hashDecision } from "./index.js";

const rec = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: "d1",
  ts: "2026-01-01T00:00:00Z",
  mode: "RESEARCH_ONLY",
  execution: "PAPER",
  clientId: null,
  tenantId: null,
  symbol: "AAA",
  lynchCategory: "fast_grower",
  understandability: { passed: true, businessSummary: "x", growthStory: "y" },
  criteria: [{ name: "PEG", value: 0.8, threshold: "<=1.0", result: "pass", weight: 0.3 }],
  convictionScore: 78,
  verdict: "buy",
  rationale: "cheap fast grower",
  sellTriggers: ["PEG>=2.0"],
  riskChecks: { position_cap: "pass" },
  intendedAction: null,
  dataProvenance: [{ field: "pe", source: "financialdatasets.ai", asOf: "2026-01-01T00:00:00Z" }],
  model: { promptVersion: "0.1", modelId: "claude", strategyConfigHash: "abc" },
  confidence: 0.7,
  abstainReason: null,
  disclaimers: ["Capital at risk."],
  ...overrides,
});

describe("hashDecision", () => {
  it("is a 64-char hex sha-256", () => {
    expect(hashDecision(rec())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical records", () => {
    expect(hashDecision(rec())).toBe(hashDecision(rec()));
  });

  it("ignores the on-chain txid (anchoring must not change the hash)", () => {
    const before = hashDecision(rec());
    const after = hashDecision(rec({ chainAnchorTxid: "TX123" }));
    expect(after).toBe(before);
  });

  it("changes when any audited field changes", () => {
    expect(hashDecision(rec({ verdict: "sell" }))).not.toBe(hashDecision(rec()));
    expect(hashDecision(rec({ convictionScore: 12 }))).not.toBe(hashDecision(rec()));
  });

  it("detects changes in NESTED fields (criteria/understandability)", () => {
    const base = hashDecision(rec());
    expect(
      hashDecision(rec({ criteria: [{ name: "PEG", value: 9.9, threshold: "<=1.0", result: "fail", weight: 0.3 }] })),
    ).not.toBe(base);
    expect(
      hashDecision(rec({ understandability: { passed: false, businessSummary: "x", growthStory: "y" } })),
    ).not.toBe(base);
  });
});
