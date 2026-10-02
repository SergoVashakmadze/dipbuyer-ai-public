#!/usr/bin/env node
/**
 * Deploys CreAnchorReceiver and allows it to anchor on the DecisionRegistry.
 *
 *   MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key \
 *   MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 \
 *   CRE_FORWARDER=0xB9F79d863261869B234c481D1f9A7af84AeAd192 \      # mock forwarder (simulation); the real one is 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
 *   [CRE_WORKFLOW_OWNER=0x...] \                                    # optional; unset/zero accepts any workflow owner
 *     node scripts/deploy-cre-receiver.mjs [--send]
 *
 * Without --send it only compiles and prints what it would do. The deployer must be the registry owner
 * (it calls setAnchorer). The key is read from a file and never printed. Forwarder addresses come from
 * `cre workflow supported-chains` (monad-testnet).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, isAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { DECISION_REGISTRY_ABI } from "../dist/registry.js";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = dirname(fileURLToPath(import.meta.url));

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is not set.`); process.exit(1); }
  return v;
};
const registry = need("MONAD_REGISTRY_ADDRESS");
const forwarder = need("CRE_FORWARDER");
const workflowOwner = process.env.CRE_WORKFLOW_OWNER || zeroAddress;
for (const [n, a] of [["registry", registry], ["forwarder", forwarder], ["workflow owner", workflowOwner]]) {
  if (!isAddress(a)) { console.error(`${n} is not an address: ${a}`); process.exit(1); }
}

const FILE = "CreAnchorReceiver.sol";
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { [FILE]: { content: readFileSync(join(here, "..", "contracts", FILE), "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); process.exit(1); }
const c = out.contracts[FILE].CreAnchorReceiver;
const abi = c.abi;
const bytecode = `0x${c.evm.bytecode.object}`;

const keyFile = need("MONAD_DEPLOYER_KEY_FILE");
const key = readFileSync(keyFile.replace(/^~/, homedir()), "utf8").trim();
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
const owner = await publicClient.readContract({ address: registry, abi: DECISION_REGISTRY_ABI, functionName: "owner" });
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`deployer ${account.address} is not the registry owner (${owner}); setAnchorer would fail.`);
  process.exit(1);
}
console.log(`registry ${registry}\nforwarder ${forwarder}\nworkflow owner ${workflowOwner}\ndeployer ${account.address}`);
if (!process.argv.includes("--send")) { console.log("dry run: nothing sent (use --send)"); process.exit(0); }

const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });
const deployHash = await wallet.deployContract({ abi, bytecode, args: [registry, forwarder, workflowOwner] });
const rcpt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
const receiver = rcpt.contractAddress;
console.log(`receiver deployed ${receiver} (tx ${deployHash})`);
const allowHash = await wallet.writeContract({ address: registry, abi: DECISION_REGISTRY_ABI, functionName: "setAnchorer", args: [receiver, true] });
await publicClient.waitForTransactionReceipt({ hash: allowHash });
console.log(`registry now allows ${receiver} to anchor (tx ${allowHash})`);
