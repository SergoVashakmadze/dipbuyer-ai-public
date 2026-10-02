// Set up an x402 PAYER (buyer) wallet on Algorand TestNet for an end-to-end paid call.
//
// The funded ZU55… account is the RECEIVER (X402_PAY_TO); a real settlement needs a *separate*
// payer that holds USDC and signs the $0.01. This script:
//   1. generates (once) a payer keypair → saved to apps/x402/.payer-testnet.json (gitignored)
//   2. [--broadcast] transfers 1 ALGO from the anchor account (ALGORAND_ANCHOR_MNEMONIC) → payer
//      (no AlgoKit dispenser needed — the anchor already holds ~10 ALGO)
//   3. [--broadcast] opts the payer into TestNet USDC (ASA 10458941)
// Then YOU faucet the payer with USDC at https://faucet.circle.com (Algorand Testnet).
//
// SAFE BY DEFAULT: without --broadcast it only generates/loads the key and prints the plan.
// With --broadcast it signs + sends 2 transactions (anchor payment + payer opt-in).
//
//   node scripts/setup-payer.mjs              # keygen + dry-run plan (no chain writes)
//   node scripts/setup-payer.mjs --broadcast  # fund 1 ALGO + opt payer into USDC

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import algosdk from "algosdk";
import dotenv from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
dotenv.config({ path: resolve(REPO_ROOT, ".env") });

const NETWORK = (process.env.NETWORK ?? process.env.ALGORAND_NETWORK ?? "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet";
const ALGOD_URL = process.env.ALGOD_URL ?? (IS_MAINNET ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud");
const USDC_ASA = Number(process.env.USDC_ASA ?? process.env.USDC_TESTNET_ASA ?? (IS_MAINNET ? 31566704 : 10458941));
const FUND_ALGO = Number(process.env.PAYER_FUND_ALGO ?? 1); // whole ALGO to send the payer
const PAYER_FILE = resolve(HERE, "..", `.payer-${NETWORK}.json`);
const BROADCAST = process.argv.includes("--broadcast");

const algod = new algosdk.Algodv2("", ALGOD_URL, "");
const microAlgos = (a) => Math.round(a * 1e6);

/** Load the saved payer, or generate + persist a fresh one. */
function loadOrCreatePayer() {
  if (existsSync(PAYER_FILE)) {
    const j = JSON.parse(readFileSync(PAYER_FILE, "utf8"));
    return { ...j, fresh: false };
  }
  const acct = algosdk.generateAccount();
  const address = acct.addr.toString();
  const mnemonic = algosdk.secretKeyToMnemonic(acct.sk);
  const skBase64 = Buffer.from(acct.sk).toString("base64"); // 64-byte sk → toClientAvmSigner input
  const payer = { address, mnemonic, skBase64 };
  writeFileSync(PAYER_FILE, JSON.stringify(payer, null, 2));
  return { ...payer, fresh: true };
}

async function sendAndWait(signed, label) {
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  console.log(`  ✓ ${label}: ${txid}`);
  return txid;
}

async function balances(address) {
  try {
    const info = await algod.accountInformation(address).do();
    const usdc = (info.assets ?? []).find((a) => Number(a.assetId ?? a["asset-id"]) === USDC_ASA);
    return { algo: Number(info.amount) / 1e6, optedIntoUsdc: !!usdc, usdc: usdc ? Number(usdc.amount) : null };
  } catch {
    return { algo: 0, optedIntoUsdc: false, usdc: null }; // account not yet on chain
  }
}

const payer = loadOrCreatePayer();
console.log(`Payer ${payer.fresh ? "GENERATED" : "loaded"}: ${payer.address}`);
console.log(`  key file: ${PAYER_FILE} (gitignored)`);

const before = await balances(payer.address);
console.log(`  current: ${before.algo} ALGO, opted into USDC=${before.optedIntoUsdc}`);

if (!BROADCAST) {
  console.log("\nDRY RUN (no chain writes). Plan with --broadcast:");
  console.log(`  1. send ${FUND_ALGO} ALGO  anchor(${(process.env.X402_PAY_TO ?? "").slice(0, 8)}…) → payer`);
  console.log(`  2. opt payer into USDC ASA ${USDC_ASA}`);
  if (IS_MAINNET) {
    console.log(`\n⚠️  MAINNET: no faucet. Send REAL USDC (ASA ${USDC_ASA}) to the payer:`);
    console.log(`     withdraw USDC on the Algorand network from an exchange/bridge → ${payer.address}`);
  } else {
    console.log(`\nThen faucet USDC to the payer: https://faucet.circle.com  (Algorand Testnet → ${payer.address})`);
  }
  process.exit(0);
}

const anchorMnemonic = process.env.ALGORAND_ANCHOR_MNEMONIC;
if (!anchorMnemonic) throw new Error("ALGORAND_ANCHOR_MNEMONIC missing in .env");
const anchor = algosdk.mnemonicToSecretKey(anchorMnemonic);
console.log(`\nBroadcasting from anchor ${anchor.addr.toString()} …`);

// 1) Fund the payer with ALGO (skip if already funded enough for opt-in + fees).
if (before.algo < 0.3) {
  const sp = await algod.getTransactionParams().do();
  const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: anchor.addr,
    receiver: payer.address,
    amount: microAlgos(FUND_ALGO),
    suggestedParams: sp,
  });
  await sendAndWait(pay.signTxn(anchor.sk), `funded payer ${FUND_ALGO} ALGO`);
} else {
  console.log(`  • payer already has ${before.algo} ALGO — skipping funding`);
}

// 2) Opt the payer into USDC (0-amount self asset-transfer). Skip if already opted in.
if (!before.optedIntoUsdc) {
  const sp = await algod.getTransactionParams().do();
  const optin = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.address,
    receiver: payer.address,
    assetIndex: USDC_ASA,
    amount: 0,
    suggestedParams: sp,
  });
  await sendAndWait(optin.signTxn(algosdk.mnemonicToSecretKey(payer.mnemonic).sk), `payer opted into USDC ${USDC_ASA}`);
} else {
  console.log(`  • payer already opted into USDC — skipping opt-in`);
}

const after = await balances(payer.address);
console.log(`\nDone. Payer ${payer.address}`);
console.log(`  ${after.algo} ALGO, opted into USDC=${after.optedIntoUsdc}, USDC balance=${after.usdc ?? 0}`);
if (IS_MAINNET) {
  console.log(`\nNext: send REAL USDC (ASA ${USDC_ASA}) on Algorand to the payer → ${payer.address}`);
} else {
  console.log(`\nNext: faucet USDC to the payer → https://faucet.circle.com (Algorand Testnet → ${payer.address})`);
}
console.log(`Then run:  node scripts/x402-pay.mjs AAPL`);
