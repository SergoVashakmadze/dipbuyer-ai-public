#!/usr/bin/env node
/**
 * Adds an anchored batch, with a few real decisions and their Merkle proofs, to the committed list
 * the public /verify/monad page reads (apps/web/public/monad-batches.json). Rebuilds the tree from
 * the run dump the same way anchor-run.mjs does and refuses to write anything unless the root
 * matches the one that was anchored. The page re-checks every listed root against the chain, so
 * this file only says WHICH batches exist; count, date and config hash always come from the chain.
 * Running it again for the same root replaces that entry.
 *
 *   node scripts/export-samples.mjs <run-dump.json> <root> <txHash> <registry> <out.json> "<label>"
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { hashDecision } from "../dist/canonical.js";
import { buildMerkleTree, proofFor, verifyProof } from "../dist/merkle.js";

const [dumpPath, expectedRoot, txHash, registry, out, label] = process.argv.slice(2);
if (!label) {
  console.error('usage: node scripts/export-samples.mjs <run-dump.json> <root> <txHash> <registry> <out.json> "<label>"');
  process.exit(1);
}
const expand = (p) => (p.startsWith("~/") ? p.replace("~", homedir()) : p);
const dump = JSON.parse(readFileSync(expand(dumpPath), "utf8"));

// Same duplicate rule as anchor-run.mjs: the first record wins.
const seen = new Set();
const unique = [];
const kept = [];
dump.decisions.forEach((d, i) => {
  const h = hashDecision(d);
  if (seen.has(h)) return;
  seen.add(h);
  unique.push(h);
  kept.push(i);
});

const tree = buildMerkleTree(unique);
if (tree.root.toLowerCase() !== expectedRoot.toLowerCase()) {
  console.error(`root mismatch: rebuilt ${tree.root}, expected ${expectedRoot}. Not writing.`);
  process.exit(2);
}

// A spread of verdicts and years, so the page shows more than one kind of decision.
const want = [
  (d) => d.verdict === "buy" && d.ts.startsWith("2017"),
  (d) => d.verdict === "avoid" && d.ts.startsWith("2019"),
  (d) => d.verdict === "hold" && d.ts.startsWith("2022"),
  (d) => d.verdict === "sell" || d.verdict === "watch",
];
const samples = [];
for (const pick of want) {
  const idx = unique.findIndex((_, u) => pick(dump.decisions[kept[u]]) && !samples.some((s) => s.index === u));
  if (idx < 0) continue;
  const decision = dump.decisions[kept[idx]];
  const proof = proofFor(tree, idx);
  if (!verifyProof(unique[idx], proof, tree.root)) throw new Error(`proof for ${idx} does not verify`);
  samples.push({ index: idx, decision, proof });
}

const entry = { root: tree.root, txHash, label, samples };
const file = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { network: "testnet", chainId: 10143, registry, batches: [] };
if (file.registry.toLowerCase() !== registry.toLowerCase()) throw new Error(`${out} lists another registry (${file.registry})`);
file.batches = [...file.batches.filter((b) => b.root.toLowerCase() !== tree.root.toLowerCase()), entry];
writeFileSync(out, JSON.stringify(file, null, 1) + "\n");
console.log(`${out}: ${file.batches.length} batch(es); "${label}" has ${samples.length} samples (${samples.map((x) => `${x.decision.symbol} ${x.decision.ts.slice(0, 10)} ${x.decision.verdict}`).join("; ")})`);
