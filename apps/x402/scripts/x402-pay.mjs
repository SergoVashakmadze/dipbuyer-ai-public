// Drive a real paid x402 call against the DipBuyer proof service on Algorand TestNet.
//
// Flow (x402 over HTTP):
//   1. GET /v1/proof?symbol=… → 402 with PaymentRequired (USDC-on-Algorand requirements)
//   2. build + sign a USDC payment from the payer (ExactAvmScheme via the payer's key)
//   3. re-GET with the X-PAYMENT header → 200 with the signed, tx-anchored Lynch proof
//   4. print the settlement txid (Lora explorer link)
//
// Prereqs: payer set up + funded with USDC (scripts/setup-payer.mjs + Circle faucet),
//          and the server running:  DOTENV_CONFIG_PATH=../../.env pnpm exec tsx src/server.ts
//
//   node scripts/x402-pay.mjs [SYMBOL] [BASE_URL]
//   node scripts/x402-pay.mjs AAPL http://localhost:3002

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import { toClientAvmSigner } from "@x402-avm/avm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
dotenv.config({ path: resolve(REPO_ROOT, ".env") });

const SYMBOL = (process.argv[2] ?? "AAPL").toUpperCase();
const BASE_URL = (process.argv[3] ?? process.env.X402_BASE_URL ?? "http://localhost:3002").replace(/\/$/, "");
const NETWORK = (process.env.NETWORK ?? process.env.ALGORAND_NETWORK ?? "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet";
const ALGOD_URL = process.env.ALGOD_URL ?? (IS_MAINNET ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud");
const PAYER_FILE = resolve(HERE, "..", `.payer-${NETWORK}.json`);

if (!existsSync(PAYER_FILE)) throw new Error(`No payer wallet for ${NETWORK} — run: NETWORK=${NETWORK} node scripts/setup-payer.mjs --broadcast`);
const payer = JSON.parse(readFileSync(PAYER_FILE, "utf8"));

// Build an x402 client that can sign Algorand USDC payments with the payer key.
const signer = toClientAvmSigner(payer.skBase64);
const client = new x402Client();
registerExactAvmScheme(client, { signer, algodConfig: { algodUrl: ALGOD_URL, algodToken: "" } });
const http = new x402HTTPClient(client);

const url = `${BASE_URL}/v1/proof?symbol=${encodeURIComponent(SYMBOL)}`;
const getHeader = (res) => (name) => res.headers.get(name);

console.log(`Payer ${payer.address}`);
console.log(`GET ${url}`);

// 1) First request — expect 402 Payment Required.
const first = await fetch(url);
if (first.status !== 402) {
  console.log(`Unexpected status ${first.status} (expected 402). Body:`, await first.text());
  process.exit(1);
}
const firstBody = await first.clone().json().catch(() => undefined);
const paymentRequired = http.getPaymentRequiredResponse(getHeader(first), firstBody);
console.log("402 received — building + signing USDC payment …");

// 2) Build + sign the payment payload, encode it into the X-PAYMENT header.
const payload = await http.createPaymentPayload(paymentRequired);
const payHeaders = http.encodePaymentSignatureHeader(payload);

// 3) Retry with payment.
const paid = await fetch(url, { headers: payHeaders });
const paidBody = await paid.clone().json().catch(() => undefined);
if (!paid.ok) {
  console.log(`Payment attempt returned ${paid.status}. Body:`, paidBody ?? (await paid.text()));
  process.exit(1);
}

// 4) Report settlement + proof.
const settle = http.getPaymentSettleResponse(getHeader(paid));
const txid = settle?.transaction ?? settle?.txid ?? settle?.txHash;
console.log("\n✅ Paid call settled.");
if (txid) {
  console.log(`  settlement txid: ${txid}`);
  console.log(`  explorer: https://lora.algokit.io/${NETWORK}/tx/${txid}`);
}
console.log("  proof:", JSON.stringify(paidBody, null, 2));
