#!/usr/bin/env node
/**
 * Adds a batch anchored by the Chainlink CRE workflow (cre/anchor) to the list /verify/monad reads.
 * Refetches the same decisions the workflow used (same API, same symbols, same asOf), rebuilds the tree
 * and refuses to write unless the root matches the anchored one. Every decision becomes a sample.
 *
 *   node scripts/export-cre-batch.mjs <root> <txHash> <asOf ISO> <out.json> "<label>" SYM1 SYM2 ...   # symbols in the workflow's order
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hashDecision } from "../dist/canonical.js";
import { buildMerkleTree, proofFor, verifyProof } from "../dist/merkle.js";

const [expectedRoot, txHash, asOf, out, label, ...symbols] = process.argv.slice(2);
if (!symbols.length) { console.error("usage: node scripts/export-cre-batch.mjs <root> <txHash> <asOf> <out.json> <label> SYM..."); process.exit(1); }
const API = process.env.DIPBUYER_API ?? "https://api.dipbuyer.ai/api";

const records = [];
for (const s of symbols) {
  const res = await fetch(`${API}/decisions/${encodeURIComponent(s)}?asOf=${encodeURIComponent(asOf)}`);
  if (!res.ok) throw new Error(`${s}: HTTP ${res.status}`);
  records.push((await res.json()).record);
}
const hashes = records.map(hashDecision);
const tree = buildMerkleTree(hashes);
if (tree.root.toLowerCase() !== expectedRoot.toLowerCase()) { console.error(`root mismatch: rebuilt ${tree.root}, expected ${expectedRoot}. Not writing.`); process.exit(2); }

const samples = records.map((decision, index) => {
  const proof = proofFor(tree, index);
  if (!verifyProof(hashes[index], proof, tree.root)) throw new Error(`proof for ${index} does not verify`);
  return { index, decision, proof };
});
const file = JSON.parse(readFileSync(out, "utf8"));
file.batches = [...file.batches.filter((b) => b.root.toLowerCase() !== tree.root.toLowerCase()), { root: tree.root, txHash, label, samples }];
writeFileSync(out, JSON.stringify(file, null, 1) + "\n");
console.log(`${out}: ${file.batches.length} batches; "${label}" has ${samples.length} samples`);
