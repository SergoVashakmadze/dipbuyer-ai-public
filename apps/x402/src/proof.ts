// ed25519 proof-signing for DipBuyer decision attestations — recycled from the
// IoMarkets.ai-x402 proof scheme. Every paid proof is a canonical payload signed
// with the server's ed25519 key; a buyer (or any third party) re-verifies offline:
//   1. check the signature against the published PROOF_PUBLIC_KEY
//   2. confirm `algorand_txid` actually settled on Algorand
// That property is what makes the paid proof real, not a demo.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/**
 * Payload format version. Bumped to 2 when `data_source` was added to the signed fields:
 * a v1 proof cannot state what data it was derived from, so it must not be treated as
 * equivalent to a v2 proof. v1 signatures do not verify under v2 canonicalization (by
 * design — the field is inside the signature so it cannot be stripped or forged).
 */
export const PAYLOAD_VERSION = 2;

/** The exact fields signed for a Lynch decision proof. Order matters — see canonicalize(). */
export interface DecisionAttestationPayload {
  payload_version: number;
  query_ts: string;       // when DipBuyer served the request (ISO-8601)
  symbol: string;
  lynch_category: string;
  verdict: string;        // buy | hold | trim | sell | avoid | abstain
  conviction_score: number;
  decision_hash: string;  // sha-256 of the full DecisionRecord
  algorand_txid: string;  // x402 settlement tx — anchors the proof on-chain
  server_pubkey: string;
  /**
   * Where the underlying fundamentals came from, e.g. "financialdatasets.ai" or
   * "in-memory-demo". SIGNED, so a buyer can always tell a real analysis from one
   * computed on demo fixtures. Without this a paid proof is a cryptographically
   * unforgeable statement about data of unknown origin — which is worse than useless,
   * because the signature lends it credibility it has not earned.
   */
  data_source: string;
}

/** True when a proof was derived from synthetic data and must not be read as real analysis. */
export function isSyntheticProof(p: DecisionAttestationPayload): boolean {
  return p.data_source === "in-memory-demo" || p.data_source === "backtest-synthetic";
}

export interface DecisionAttestation {
  payload: DecisionAttestationPayload;
  signature: string;
}

export function canonicalize(p: DecisionAttestationPayload): string {
  return JSON.stringify([
    p.payload_version, p.query_ts, p.symbol, p.lynch_category, p.verdict,
    p.conviction_score, p.decision_hash, p.algorand_txid, p.server_pubkey, p.data_source,
  ]);
}

export function derivePublicKey(privHex: string): string {
  return toHex(ed.getPublicKey(fromHex(privHex)));
}
export function generateKeypair(): { privateKey: string; publicKey: string } {
  const priv = ed.utils.randomPrivateKey();
  return { privateKey: toHex(priv), publicKey: toHex(ed.getPublicKey(priv)) };
}
export function sign(payload: Omit<DecisionAttestationPayload, "server_pubkey">, privHex: string): DecisionAttestation {
  const full: DecisionAttestationPayload = { ...payload, server_pubkey: derivePublicKey(privHex) };
  const signature = toHex(ed.sign(enc.encode(canonicalize(full)), fromHex(privHex)));
  return { payload: full, signature };
}
export function verifySignature(att: DecisionAttestation): boolean {
  try {
    return ed.verify(fromHex(att.signature), enc.encode(canonicalize(att.payload)), fromHex(att.payload.server_pubkey));
  } catch {
    return false;
  }
}
