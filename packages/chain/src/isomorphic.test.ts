import { describe, expect, it, vi } from "vitest";
import type { DecisionRecord } from "@dipbuyer/shared";
import { hashDecision } from "./index.js";
import { checkAnchor, decodeNoteIsomorphic, hashDecisionAsync } from "./isomorphic.js";

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

const txResponse = (note: string | undefined, extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ transaction: { note, "confirmed-round": 100, "round-time": 1750000000, ...extra } }),
  }) as Response;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("isomorphic hashing parity", () => {
  it("Web Crypto path produces the SAME hash as the node path", async () => {
    // If these diverge, a record verifies in the browser but fails on the server (or worse,
    // the reverse) — silently breaking the entire audit-trail guarantee.
    const r = rec();
    expect(await hashDecisionAsync(r)).toBe(hashDecision(r));
  });

  it("stays in parity for nested/reordered keys and unicode", async () => {
    const r = rec({
      symbol: "ÅÄÖ",
      rationale: "emoji ✅ and quotes \" ' \\",
      criteria: [
        { name: "z", value: 1, threshold: "x", result: "pass", weight: 0.1 },
        { name: "a", value: 2, threshold: "y", result: "fail", weight: 0.2 },
      ],
    });
    expect(await hashDecisionAsync(r)).toBe(hashDecision(r));
  });

  it("excludes chainAnchorTxid in both paths (assigned after hashing)", async () => {
    const base = rec();
    const anchored = { ...base, chainAnchorTxid: "TX999" };
    expect(await hashDecisionAsync(anchored)).toBe(await hashDecisionAsync(base));
    expect(hashDecision(anchored)).toBe(hashDecision(base));
  });
});

describe("decodeNoteIsomorphic", () => {
  it("decodes base64 without Buffer", () => {
    expect(decodeNoteIsomorphic(b64("hello"))).toBe("hello");
  });
});

describe("checkAnchor", () => {
  it("matches when the on-chain note equals the locally recomputed hash", async () => {
    const r = rec();
    const hash = await hashDecisionAsync(r);
    const fetchImpl = vi.fn(async () => txResponse(b64(hash)));
    const out = await checkAnchor(r, "TX1", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(true);
    expect(out.onChainHash).toBe(hash);
    expect(out.confirmedRound).toBe(100);
    expect(out.error).toBeNull();
  });

  it("reports a MISMATCH distinctly from a missing tx — tampering must not look like a typo", async () => {
    const r = rec();
    const fetchImpl = vi.fn(async () => txResponse(b64("0".repeat(64))));
    const out = await checkAnchor(r, "TX1", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
    expect(out.error).toBeNull(); // a clean answer: it resolved, and it did not match
    expect(out.onChainHash).toBe("0".repeat(64));
    expect(out.localHash).not.toBe(out.onChainHash);
  });

  it("detects a tampered record — changing the verdict breaks the anchor", async () => {
    const original = rec();
    const anchoredHash = await hashDecisionAsync(original);
    const tampered = rec({ verdict: "sell" });
    const fetchImpl = vi.fn(async () => txResponse(b64(anchoredHash)));
    const out = await checkAnchor(tampered, "TX1", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
  });

  it("explains a 404 rather than reporting a bare failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    const out = await checkAnchor(rec(), "NOPE", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
    expect(out.error).toMatch(/not found/i);
  });

  it("treats a 400 as a malformed txid — the live indexer returns 400, not 404, for a typo", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400 }) as Response);
    const out = await checkAnchor(rec(), "NOTAREALTXID", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
    expect(out.error).toMatch(/not a valid/i);
  });

  it("explains a note-less transaction", async () => {
    const fetchImpl = vi.fn(async () => txResponse(undefined));
    const out = await checkAnchor(rec(), "TX1", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
    expect(out.error).toMatch(/no note/i);
    expect(out.confirmedRound).toBe(100); // still surfaces what it could read
  });

  it("explains an unreachable indexer instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = await checkAnchor(rec(), "TX1", "https://idx", fetchImpl as unknown as typeof fetch);
    expect(out.matches).toBe(false);
    expect(out.error).toMatch(/could not reach indexer/i);
  });
});
