// Recirculating VOLUME driver for the DipBuyer x402 mainnet endpoint.
//
// Drives N real paid x402 calls (payer P → loop-receiver R) and RETURNS each payment
// R → P, so a tiny USDC float recirculates indefinitely and only ALGO fees are consumed.
// Every P→R leg is a genuine on-chain USDC settlement through the GoPlausible facilitator
// (real leaderboard usage) — the R→P return leg is a plain asset transfer that just
// refills the payer so the loop is self-sustaining.
//
// Bootstraps the loop-receiver R on first run (.receiver-mainnet.json, gitignored),
// funding its ALGO + USDC opt-in FROM the payer (no extra user funds needed).
//
//   NETWORK=mainnet node scripts/drive-volume.mjs --calls 10 --url https://<app>.up.railway.app
//   NETWORK=mainnet node scripts/drive-volume.mjs --calls 1                 # setup + smoke-test one cycle
//
// IMPORTANT: the TARGET SERVER's X402_PAY_TO must equal the loop-receiver R that this
// script prints on first run. It asserts the 402's payTo == R and aborts otherwise, so
// you can't accidentally leak USDC to the wrong receiver.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import algosdk from "algosdk";
import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import { toClientAvmSigner } from "@x402-avm/avm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
dotenv.config({ path: resolve(REPO_ROOT, ".env") });

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CALLS = Number(getArg("calls", "5"));
const BASE_URL = (getArg("url", process.env.X402_BASE_URL ?? "http://localhost:3002")).replace(/\/$/, "");
const SYMBOLS = getArg("symbols", "AAPL,MSFT,NVDA,GOOGL,AMZN").split(",").map((s) => s.trim().toUpperCase());
const INTERVAL_MS = Number(getArg("interval", "1500"));

const NETWORK = (process.env.NETWORK ?? process.env.ALGORAND_NETWORK ?? "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet";
const ALGOD_URL = process.env.ALGOD_URL ?? (IS_MAINNET ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud");
const USDC_ASA = Number(process.env.USDC_ASA ?? (IS_MAINNET ? 31566704 : 10458941));
// R holds 1 ASA → 0.2 ALGO min balance; keep a buffer above it for return-leg fees.
const RECEIVER_ALGO_FLOOR = 0.205; // top up R only when it dips below this…
const RECEIVER_ALGO_TARGET = 0.3;  // …refilling toward this (≈100 return-leg fees of headroom)
const PAYER_ALGO_RESERVE = 0.15;   // never let a top-up drop the payer below this (its own fees + min bal)

const algod = new algosdk.Algodv2("", ALGOD_URL, "");
const micro = (a) => Math.round(a * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAYER_FILE = resolve(HERE, "..", `.payer-${NETWORK}.json`);
const RECEIVER_FILE = resolve(HERE, "..", `.receiver-${NETWORK}.json`);

if (!existsSync(PAYER_FILE)) throw new Error(`No payer wallet for ${NETWORK} — run: NETWORK=${NETWORK} node scripts/setup-payer.mjs --broadcast`);
const payer = JSON.parse(readFileSync(PAYER_FILE, "utf8"));

/** Load or generate the loop-receiver R (holds a key we control, so we can return payments). */
function loadOrCreateReceiver() {
  if (existsSync(RECEIVER_FILE)) return { ...JSON.parse(readFileSync(RECEIVER_FILE, "utf8")), fresh: false };
  const acct = algosdk.generateAccount();
  const r = { address: acct.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(acct.sk), skBase64: Buffer.from(acct.sk).toString("base64") };
  writeFileSync(RECEIVER_FILE, JSON.stringify(r, null, 2));
  return { ...r, fresh: true };
}
const receiver = loadOrCreateReceiver();

async function balances(address) {
  try {
    const info = await algod.accountInformation(address).do();
    const a = (info.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === USDC_ASA);
    return { algo: Number(info.amount) / 1e6, optedIntoUsdc: !!a, usdc: a ? Number(a.amount) / 1e6 : 0 };
  } catch {
    return { algo: 0, optedIntoUsdc: false, usdc: 0 };
  }
}

async function sendAndWait(signed, label) {
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  console.log(`    ↩ ${label}: ${txid}`);
  return txid;
}

// ── bootstrap the loop-receiver (fund ALGO + opt into USDC, from the payer) ────
console.log(`Network        : ${NETWORK}`);
console.log(`Target server  : ${BASE_URL}`);
console.log(`Payer      (P) : ${payer.address}`);
console.log(`Loop rcvr  (R) : ${receiver.address}${receiver.fresh ? "  (GENERATED)" : ""}`);
console.log(`Key file       : ${RECEIVER_FILE} (gitignored)\n`);

let rBal = await balances(receiver.address);
if (rBal.algo < RECEIVER_ALGO_FLOOR) {
  const topUp = micro(RECEIVER_ALGO_TARGET - rBal.algo);
  const pBal = await balances(payer.address);
  if (micro(pBal.algo) - topUp < micro(PAYER_ALGO_RESERVE)) {
    throw new Error(`payer ALGO ${pBal.algo} too low to top up R (need ${topUp / 1e6} + ${PAYER_ALGO_RESERVE} reserve) — send more ALGO to the payer ${payer.address}`);
  }
  const sp = await algod.getTransactionParams().do();
  const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: payer.address, receiver: receiver.address, amount: topUp, suggestedParams: sp,
  });
  await sendAndWait(pay.signTxn(algosdk.mnemonicToSecretKey(payer.mnemonic).sk), `topped up R to ${RECEIVER_ALGO_TARGET} ALGO from P`);
  rBal = await balances(receiver.address);
}
if (!rBal.optedIntoUsdc) {
  const sp = await algod.getTransactionParams().do();
  const optin = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: receiver.address, receiver: receiver.address, assetIndex: USDC_ASA, amount: 0, suggestedParams: sp,
  });
  await sendAndWait(optin.signTxn(algosdk.mnemonicToSecretKey(receiver.mnemonic).sk), `R opted into USDC ${USDC_ASA}`);
}

// ── x402 paying client (signs USDC payments with the payer key) ───────────────
const signer = toClientAvmSigner(payer.skBase64);
const client = new x402Client();
registerExactAvmScheme(client, { signer, algodConfig: { algodUrl: ALGOD_URL, algodToken: "" } });
const http = new x402HTTPClient(client);
const getHeader = (res) => (name) => res.headers.get(name);
const rSk = algosdk.mnemonicToSecretKey(receiver.mnemonic).sk;

/** One paid x402 call (P → R via the server), then return that USDC R → P. */
async function oneCycle(symbol) {
  const url = `${BASE_URL}/v1/proof?symbol=${encodeURIComponent(symbol)}`;
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
  const firstBody = await first.clone().json().catch(() => undefined);
  const paymentRequired = http.getPaymentRequiredResponse(getHeader(first), firstBody);

  // SAFETY: never pay unless the server directs funds to the wallet we can return from.
  const accepts = paymentRequired?.accepts?.[0] ?? {};
  const payTo = accepts.payTo ?? accepts.pay_to;
  if (payTo && payTo !== receiver.address) {
    throw new Error(`server X402_PAY_TO=${payTo} != loop receiver R=${receiver.address}. Set the server's X402_PAY_TO to R before driving volume.`);
  }
  const priceMicro = Number(accepts.maxAmountRequired ?? accepts.price ?? micro(0.01)) || micro(0.01);

  const payload = await http.createPaymentPayload(paymentRequired);
  const payHeaders = http.encodePaymentSignatureHeader(payload);
  const paid = await fetch(url, { headers: payHeaders });
  const paidBody = await paid.clone().json().catch(() => undefined);
  if (!paid.ok) throw new Error(`payment returned ${paid.status}: ${JSON.stringify(paidBody)}`);
  const settle = http.getPaymentSettleResponse(getHeader(paid));
  const payTxid = settle?.transaction ?? settle?.txid ?? settle?.txHash;

  // Return leg: R → P for the same amount, so the float recirculates.
  const sp = await algod.getTransactionParams().do();
  const back = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: receiver.address, receiver: payer.address, assetIndex: USDC_ASA, amount: priceMicro, suggestedParams: sp,
  });
  const backTxid = await (async () => { const { txid } = await algod.sendRawTransaction(back.signTxn(rSk)).do(); await algosdk.waitForConfirmation(algod, txid, 6); return txid; })();

  return { payTxid, backTxid, priceMicro };
}

// ── drive ─────────────────────────────────────────────────────────────────────
const pStart = await balances(payer.address);
console.log(`Driving ${CALLS} paid call(s), ${INTERVAL_MS}ms apart. Payer float: ${pStart.usdc} USDC, ${pStart.algo} ALGO.\n`);

let ok = 0, settledMicro = 0;
for (let i = 1; i <= CALLS; i++) {
  const symbol = SYMBOLS[(i - 1) % SYMBOLS.length];
  const pb = await balances(payer.address);
  if (pb.usdc < 0.01) { console.log(`  ! payer USDC ${pb.usdc} < 0.01 — stopping.`); break; }
  try {
    const { payTxid, backTxid, priceMicro } = await oneCycle(symbol);
    ok++; settledMicro += priceMicro;
    console.log(`  [${i}/${CALLS}] ${symbol}  pay ${payTxid?.slice(0, 10)}…  return ${backTxid?.slice(0, 10)}…  (${priceMicro / 1e6} USDC)`);
    console.log(`         https://lora.algokit.io/${NETWORK}/tx/${payTxid}`);
  } catch (e) {
    console.log(`  [${i}/${CALLS}] ${symbol}  ✗ ${e.message}`);
    if (String(e.message).includes("X402_PAY_TO")) break; // misconfig — don't spin
  }
  if (i < CALLS) await sleep(INTERVAL_MS);
}

const pEnd = await balances(payer.address);
console.log(`\nDone. ${ok}/${CALLS} settled  |  volume ${settledMicro / 1e6} USDC  |  payer float now ${pEnd.usdc} USDC, ${pEnd.algo} ALGO (Δ ${(pEnd.algo - pStart.algo).toFixed(4)} ALGO fees).`);
