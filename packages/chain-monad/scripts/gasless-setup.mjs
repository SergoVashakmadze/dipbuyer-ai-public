#!/usr/bin/env node
/**
 * One-time setup for gasless anchoring.
 *
 *   MONAD_ANCHOR_SIGNER_KEY_FILE=~/.dipbuyer/monad-anchor-signer.key \
 *   MONAD_REGISTRY_ADDRESS=0x... \
 *     node scripts/gasless-setup.mjs            # prints the smart account address, sends nothing
 *
 *   ... MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key node scripts/gasless-setup.mjs --allow
 *       # the registry owner allows that smart account to anchor (one ordinary transaction, owner pays)
 *
 * The signer key signs UserOperations and never pays gas, so it can be a fresh key holding nothing.
 * Keys are read from files, never arguments, and are never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { smartAccountAddress } from "../dist/gasless.js";
import { DECISION_REGISTRY_ABI } from "../dist/registry.js";

const expand = (p) => (p.startsWith("~/") ? p.replace("~", homedir()) : p);
function readKey(envName) {
  const f = process.env[envName];
  if (!f) {
    console.error(`${envName} is not set. Point it at a file containing a 0x-prefixed 32-byte private key.`);
    process.exit(1);
  }
  const key = readFileSync(expand(f), "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error(`${f} does not contain a 0x-prefixed 32-byte private key.`);
    process.exit(1);
  }
  return key;
}

const chain = process.env.MONAD_NETWORK === "mainnet" ? monad : monadTestnet;
const registry = process.env.MONAD_REGISTRY_ADDRESS;
if (!registry) {
  console.error("MONAD_REGISTRY_ADDRESS is not set");
  process.exit(1);
}

const signer = privateKeyToAccount(readKey("MONAD_ANCHOR_SIGNER_KEY_FILE"));
const rpc = process.env.MONAD_RPC_URL || undefined;
const smart = await smartAccountAddress(chain, signer, rpc);
console.log(`smart account: ${smart}   (signer ${signer.address} signs; this address is what the registry sees)`);

const publicClient = createPublicClient({ chain, transport: http(rpc) });
const allowed = await publicClient.readContract({ address: registry, abi: DECISION_REGISTRY_ABI, functionName: "anchorers", args: [smart] });
console.log(`allowed to anchor on ${registry}: ${allowed}`);

if (process.argv.includes("--allow")) {
  if (allowed) {
    console.log("already allowed, nothing to do");
  } else {
    const owner = privateKeyToAccount(readKey("MONAD_DEPLOYER_KEY_FILE"));
    const wallet = createWalletClient({ account: owner, chain, transport: http(rpc) });
    const hash = await wallet.writeContract({ address: registry, abi: DECISION_REGISTRY_ABI, functionName: "setAnchorer", args: [smart, true] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`setAnchorer reverted: ${hash}`);
    console.log(`allowed: tx ${hash}`);
  }
}
