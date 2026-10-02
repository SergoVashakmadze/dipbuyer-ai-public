#!/usr/bin/env node
/**
 * Registers DipBuyer AI in the canonical ERC-8004 Identity Registry on Monad testnet.
 *
 *   MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key node scripts/register-agent-8004.mjs [--send]
 *
 * Without --send it only simulates and prints the agentId it would get. The key is read from a file and never printed.
 * The agentURI must already resolve (apps/web/public/agent-registration.json, deployed to dipbuyer.ai).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const AGENT_URI = "https://dipbuyer.ai/agent-registration.json";
const abi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const f = process.env.MONAD_DEPLOYER_KEY_FILE;
if (!f) { console.error("MONAD_DEPLOYER_KEY_FILE is not set."); process.exit(1); }
const key = readFileSync(f.replace(/^~/, homedir()), "utf8").trim();
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });

const res = await fetch(AGENT_URI);
if (!res.ok) { console.error(`${AGENT_URI} returned ${res.status}; deploy the web app first.`); process.exit(1); }

const { result } = await publicClient.simulateContract({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: [AGENT_URI], account });
console.log(`would register as agentId ${result}`);
if (!process.argv.includes("--send")) process.exit(0);

const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });
const hash = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: [AGENT_URI] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const [ev] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Registered" });
console.log(`registered: agentId ${ev?.args.agentId}, tx ${hash}`);
