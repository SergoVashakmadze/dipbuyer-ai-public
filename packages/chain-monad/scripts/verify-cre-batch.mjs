#!/usr/bin/env node
/**
 * Read-only reproduction of the Chainlink CRE batch: refetch the same decisions from the public DipBuyer API,
 * rebuild the Merkle root locally, and compare it with what the registry on Monad testnet holds. No keys, no
 * transactions. Needs `pnpm install` and `pnpm --filter @dipbuyer/chain-monad build` first.
 *
 *   node scripts/verify-cre-batch.mjs
 *   node scripts/verify-cre-batch.mjs <root> <asOf ISO> SYM1 SYM2 ...      # another batch, symbols in the workflow's order
 */
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { hashDecision } from "../dist/canonical.js";
import { buildMerkleTree } from "../dist/merkle.js";
import { MonadVerifier } from "../dist/registry.js";

const REGISTRY = "0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121";
const [rootArg, asOfArg, ...symArg] = process.argv.slice(2);
const root = rootArg ?? "0x4d548a4dfd4f354c83410a00982dac5d09bfafff47e0203723e5bcbd79d23903";
const asOf = asOfArg ?? "2026-10-02T00:00:00.000Z";
const symbols = symArg.length ? symArg : ["AAPL", "MSFT", "KO", "JNJ", "XOM"];
const API = process.env.DIPBUYER_API ?? "https://api.dipbuyer.ai/api";

console.log(`asOf ${asOf}, symbols ${symbols.join(",")}`);
const hashes = [];
for (const s of symbols) {
  const res = await fetch(`${API}/decisions/${encodeURIComponent(s)}?asOf=${encodeURIComponent(asOf)}`);
  if (!res.ok) throw new Error(`${s}: HTTP ${res.status}`);
  const h = hashDecision((await res.json()).record);
  hashes.push(h);
  console.log(`  ${s.padEnd(5)} decision hash ${h}`);
}
const rebuilt = buildMerkleTree(hashes).root;
console.log(`rebuilt root  ${rebuilt}`);
console.log(`expected root ${root}`);
console.log(`roots match:  ${rebuilt.toLowerCase() === root.toLowerCase() ? "YES" : "NO"}`);

const verifier = new MonadVerifier({ publicClient: createPublicClient({ chain: monadTestnet, transport: http() }), address: REGISTRY });
const info = await verifier.batchInfo(rebuilt);
if (!info) { console.log("anchored on Monad: NO (the registry has never seen this root)"); process.exit(2); }
console.log(`anchored on Monad: YES, ${info.decisionCount} decisions, ${info.anchoredAt.toUTCString()}, by ${info.anchoredBy}`);
process.exit(rebuilt.toLowerCase() === root.toLowerCase() ? 0 : 1);
