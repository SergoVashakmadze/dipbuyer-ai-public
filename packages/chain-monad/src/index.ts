/**
 * Monad anchoring for DipBuyer AI decisions.
 *
 * The Algorand path in @dipbuyer/chain anchors one decision per transaction. This package anchors
 * a whole run as a single Merkle root, so a rebalance of ~500 decisions costs one transaction and
 * any individual decision is still provable with a ~9-hash inclusion proof.
 */
export { canonicalJson, hashDecision } from "./canonical.js";
export { buildMerkleTree, leafOf, proofFor, verifyProof } from "./merkle.js";
export type { DecisionHash, MerkleTree } from "./merkle.js";

export { MonadAnchorer, MonadVerifier, DECISION_REGISTRY_ABI, DECISION_REGISTRY_BYTECODE } from "./registry.js";
export type { AnchoredBatch, MonadAnchorerOptions, MonadRegistryOptions } from "./registry.js";
export { GaslessAnchorer, createGaslessAnchorer, smartAccountAddress } from "./gasless.js";
export type { CreateGaslessAnchorerOptions, GaslessAnchorerOptions, UserOpSender } from "./gasless.js";
