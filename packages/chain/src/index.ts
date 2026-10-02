import { createHash } from "node:crypto";
import type { DecisionRecord } from "@dipbuyer/shared";
import { canonicalStringOf } from "./isomorphic.js";

/**
 * Algorand audit anchoring. Hash the decision artifact OFF-chain, write ONLY the hash into
 * the 1 kB Algorand note field. NEVER write PII/MNPI on-chain. On-chain proves integrity &
 * timing, not correctness. The off-chain store remains system of record. See the engineering design notes
 */

/**
 * Canonical, stable, deep hash of a DecisionRecord (chainAnchorTxid excluded).
 *
 * Canonicalization is imported from ./isomorphic so the Node and browser verifiers hash the
 * SAME bytes — if these ever diverged, a record would verify in one and fail in the other,
 * which is worse than no verification at all. `hash.test.ts` asserts they agree.
 */
export function hashDecision(record: DecisionRecord): string {
  return createHash("sha256").update(canonicalStringOf(record)).digest("hex");
}

export interface Anchorer {
  /** Writes the hash to an Algorand tx note; returns the txid. */
  anchor(hash: string): Promise<string>;
}

export interface Verifier {
  /** Confirms the hash exists in a tx note via a public indexer (no server trust). */
  verify(hash: string, txid: string): Promise<boolean>;
}

export { AlgodAnchorer, encodeNote } from "./anchor.js";
export type { AlgodAnchorerOptions } from "./anchor.js";
export { IndexerVerifier, decodeNote } from "./verify.js";
export type { IndexerVerifierOptions } from "./verify.js";
export {
  canonicalStringOf,
  hashDecisionAsync,
  sha256Hex,
  decodeNoteIsomorphic,
  checkAnchor,
} from "./isomorphic.js";
export type { AnchorCheck } from "./isomorphic.js";
// TODO(phase-4): optional Merkle batching (one tx anchors N decision hashes).
