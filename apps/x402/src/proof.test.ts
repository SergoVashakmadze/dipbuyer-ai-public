import { describe, expect, it } from "vitest";
import {
  canonicalize,
  generateKeypair,
  isSyntheticProof,
  sign,
  verifySignature,
  PAYLOAD_VERSION,
  type DecisionAttestationPayload,
} from "./proof.js";

const basePayload = (over: Partial<DecisionAttestationPayload> = {}): Omit<DecisionAttestationPayload, "server_pubkey"> => ({
  payload_version: PAYLOAD_VERSION,
  query_ts: "2026-07-19T12:00:00Z",
  symbol: "AAPL",
  lynch_category: "fast-grower",
  verdict: "buy",
  conviction_score: 82,
  decision_hash: "a".repeat(64),
  algorand_txid: "TX123",
  data_source: "financialdatasets.ai",
  ...over,
});

describe("decision attestation", () => {
  it("round-trips a signature", () => {
    const { privateKey } = generateKeypair();
    const att = sign(basePayload(), privateKey);
    expect(verifySignature(att)).toBe(true);
  });

  it("binds data_source INSIDE the signature — it cannot be swapped to fake real data", () => {
    const { privateKey } = generateKeypair();
    const att = sign(basePayload({ data_source: "in-memory-demo" }), privateKey);
    expect(verifySignature(att)).toBe(true);

    // Attacker rewrites a demo proof to claim it came from real data.
    const forged = { ...att, payload: { ...att.payload, data_source: "financialdatasets.ai" } };
    expect(verifySignature(forged)).toBe(false);
  });

  it("binds payload_version so a v1 proof cannot be replayed as v2", () => {
    const { privateKey } = generateKeypair();
    const att = sign(basePayload(), privateKey);
    const downgraded = { ...att, payload: { ...att.payload, payload_version: 1 } };
    expect(verifySignature(downgraded)).toBe(false);
  });

  it("canonicalize covers every signed field", () => {
    const p = { ...basePayload(), server_pubkey: "b".repeat(64) };
    const canon = canonicalize(p);
    for (const v of [
      p.payload_version,
      p.query_ts,
      p.symbol,
      p.lynch_category,
      p.verdict,
      p.conviction_score,
      p.decision_hash,
      p.algorand_txid,
      p.server_pubkey,
      p.data_source,
    ]) {
      expect(canon).toContain(String(v));
    }
  });

  it("flags synthetic sources so a demo proof is never read as real analysis", () => {
    expect(isSyntheticProof({ ...basePayload({ data_source: "in-memory-demo" }), server_pubkey: "" })).toBe(true);
    expect(isSyntheticProof({ ...basePayload({ data_source: "backtest-synthetic" }), server_pubkey: "" })).toBe(true);
    expect(isSyntheticProof({ ...basePayload({ data_source: "financialdatasets.ai" }), server_pubkey: "" })).toBe(false);
  });
});
