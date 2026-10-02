// DipBuyer x402 service — a paid endpoint that SELLS verifiable Peter Lynch stock-pick proofs.
// Recycled from IoMarkets.ai-x402: @x402-avm/hono paymentMiddleware + GoPlausible facilitator,
// settling USDC on Algorand. The payment unlocks a cryptographically-signed, on-chain-anchored
// Lynch decision — the "verification services" use case of the Algorand Global x402 Challenge.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { paymentMiddleware } from "@x402-avm/hono";
import { x402ResourceServer, HTTPFacilitatorClient, type RoutesConfig } from "@x402-avm/core/server";
import type { Network } from "@x402-avm/core/types";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions/bazaar";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402-avm/avm";
import type { Fundamentals } from "@dipbuyer/shared";
import { DecisionService, createLlmUnderstandabilityProvider } from "@dipbuyer/agent";
import { InMemoryFundamentals, FinancialDatasetsFundamentals, isSyntheticSource } from "@dipbuyer/data";
import {
  sign,
  generateKeypair,
  derivePublicKey,
  PAYLOAD_VERSION,
  type DecisionAttestationPayload,
} from "./proof.js";

const NETWORK = (process.env.NETWORK ?? process.env.ALGORAND_NETWORK ?? "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet";
const CAIP2 = (IS_MAINNET ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2) as Network;
const USDC = IS_MAINNET ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
const PAY_TO = process.env.X402_PAY_TO ?? process.env.PAY_TO ?? "";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const PRICE = process.env.X402_PROOF_PRICE ?? "$0.01";
const PORT = Number(process.env.PORT ?? process.env.PORT_X402 ?? 3002); // Railway injects $PORT

// Proof key: persistent from env, else ephemeral (dev) with a warning.
let PROOF_PRIV = process.env.PROOF_PRIVATE_KEY ?? "";
if (!PROOF_PRIV) {
  PROOF_PRIV = generateKeypair().privateKey;
  console.warn("[x402] PROOF_PRIVATE_KEY unset — using an EPHEMERAL key (set one for stable proofs).");
}
const PROOF_PUB = derivePublicKey(PROOF_PRIV);

// Fundamentals: financialdatasets when keyed, else a small demo universe.
function demoFundamentals(): Map<string, Fundamentals[]> {
  const mk = (symbol: string, pe: number, growth: number): Fundamentals =>
    ({ symbol, asOf: "2026-01-01T00:00:00Z", peRatio: pe, epsGrowthPct: growth, epsGrowthHistoryPct: [growth - 2, growth - 1, growth], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: growth + 3, inventoryGrowthPct: 5, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: pe, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null }) as Fundamentals;
  return new Map([["AAPL", [mk("AAPL", 12, 25)]], ["MSFT", [mk("MSFT", 18, 15)]], ["RICH", [mk("RICH", 60, 25)]]]);
}
const fdKey = process.env.FINANCIALDATASETS_API_KEY;
const fundamentals = fdKey ? new FinancialDatasetsFundamentals({ apiKey: fdKey }) : new InMemoryFundamentals(demoFundamentals());

// LLM Lynch narrative: fills the understandability seam when an LLM key is present.
// Provider-agnostic (OpenAI-compatible) — defaults to Groq; override via LLM_BASE_URL/LLM_MODEL.
const llmKey = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY;
const understandabilityProvider = llmKey
  ? createLlmUnderstandabilityProvider({
      apiKey: llmKey,
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL,
    })
  : undefined;
if (!understandabilityProvider) console.warn("[x402] LLM_API_KEY/GROQ_API_KEY unset — proofs use the placeholder narrative gate.");

const decisions = new DecisionService({ fundamentals, understandabilityProvider, modelId: "dipbuyer-x402", promptVersion: "0.1" });

// ── finalizeProof: sign the attestation with the SETTLED Algorand txid ──────────
type ProofPending = {
  sign: Omit<DecisionAttestationPayload, "server_pubkey" | "algorand_txid">;
  narrative?: { businessSummary: string; growthStory: string };
};
const app = new Hono<{ Variables: { proof?: ProofPending } }>();

function settledTxid(c: Context): string | undefined {
  const raw = c.res.headers.get("PAYMENT-RESPONSE") ?? c.res.headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return undefined;
  try {
    const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    return (d.transaction ?? d.txid ?? d.txHash) as string | undefined;
  } catch {
    return undefined;
  }
}

app.use("*", async (c, next) => {
  await next();
  const pending = c.get("proof");
  if (!pending) return;
  const txid = settledTxid(c);
  if (!txid) {
    c.res = c.json({ error: "settlement txid unavailable; proof not issued" }, 502);
    return;
  }
  const attestation = sign({ ...pending.sign, algorand_txid: txid }, PROOF_PRIV);
  const settle = c.res.headers.get("PAYMENT-RESPONSE");
  c.res = c.json({ attestation, narrative: pending.narrative, verify: { proof_public_key: PROOF_PUB, network: NETWORK } });
  if (settle) c.res.headers.set("PAYMENT-RESPONSE", settle);
});

// ── x402 payment wall ───────────────────────────────────────────────────────
const routes: RoutesConfig = {
  "GET /v1/proof": {
    accepts: { scheme: "exact" as const, network: CAIP2, payTo: PAY_TO, price: PRICE, extra: { asset: USDC } },
    description: "A cryptographically-signed, on-chain-anchored Peter Lynch decision proof for a stock (?symbol=AAPL).",
    // Bazaar discovery: makes the endpoint self-describing so the facilitator auto-lists it.
    extensions: {
      ...declareDiscoveryExtension({
        input: { symbol: "AAPL" },
        inputSchema: {
          properties: { symbol: { type: "string", description: "US equity ticker, e.g. AAPL" } },
          required: ["symbol"],
        },
        output: {
          example: {
            attestation: {
              symbol: "AAPL",
              lynch_category: "fast-grower",
              verdict: "BUY",
              conviction_score: 0.82,
              decision_hash: "<sha-256>",
              algorand_txid: "<settlement txid>",
            },
            verify: { proof_public_key: "<ed25519 pubkey>", network: NETWORK },
          },
        },
      }),
    },
  },
};
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitator);
registerExactAvmScheme(resourceServer);
resourceServer.registerExtension(bazaarResourceServerExtension);
app.use("*", paymentMiddleware(routes, resourceServer));

// ── routes ──────────────────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    service: "DipBuyer AI — x402 verifiable stock-pick proofs",
    network: NETWORK,
    facilitator: FACILITATOR,
    pay_to: PAY_TO || "(unset)",
    proof_public_key: PROOF_PUB,
    free: "GET /v1/decision?symbol=AAPL",
    paid: `GET /v1/proof?symbol=AAPL  (${PRICE} USDC on Algorand via x402)`,
  }),
);
app.get("/health", (c) => c.json({ ok: true, network: NETWORK, payTo: !!PAY_TO }));

// Free teaser: the verdict, no signature/anchor.
app.get("/v1/decision", async (c) => {
  const symbol = (c.req.query("symbol") ?? "").toUpperCase();
  if (!symbol) return c.json({ error: "symbol query param required" }, 400);
  const { record } = await decisions.analyze(symbol, { mode: "RESEARCH_ONLY", execution: "PAPER" });
  return c.json({
    symbol, verdict: record.verdict, lynch_category: record.lynchCategory,
    conviction_score: record.convictionScore, rationale: record.rationale,
    business_summary: record.understandability.businessSummary,
    growth_story: record.understandability.growthStory,
    data_source: fundamentals.sourceId,
    synthetic: isSyntheticSource(fundamentals.sourceId),
    note: "Pay via x402 at /v1/proof for a signed, on-chain-anchored proof.",
  });
});

// Paid: settle USDC on Algorand, then return a signed + tx-anchored proof.
/**
 * Selling a SIGNED proof derived from demo fixtures, for real money, misrepresents it: the
 * signature is valid, so it lends unearned credibility to a claim about a company that was
 * never actually analysed. Refuse by default. Set X402_ALLOW_SYNTHETIC_PROOFS=true only for
 * testnet/demo environments where buyers know the data is fake.
 */
const ALLOW_SYNTHETIC_PROOFS = process.env.X402_ALLOW_SYNTHETIC_PROOFS === "true";
if (isSyntheticSource(fundamentals.sourceId) && !ALLOW_SYNTHETIC_PROOFS) {
  console.warn(
    `[x402] fundamentals source is "${fundamentals.sourceId}" (not real data) — /v1/proof will refuse ` +
      `to sell signed proofs. Set FINANCIALDATASETS_API_KEY for real data, or ` +
      `X402_ALLOW_SYNTHETIC_PROOFS=true to sell demo proofs anyway.`,
  );
}

app.get("/v1/proof", async (c) => {
  const symbol = (c.req.query("symbol") ?? "").toUpperCase();
  if (!symbol) return c.json({ error: "symbol query param required" }, 400);
  if (isSyntheticSource(fundamentals.sourceId) && !ALLOW_SYNTHETIC_PROOFS) {
    // 503, not 402: do not take payment for something we cannot honestly deliver.
    return c.json(
      {
        error: "Signed proofs unavailable",
        reason: `This instance is running on "${fundamentals.sourceId}" data, not real fundamentals. ` +
          `A signed proof would attest to a demo fixture, so it is not offered for sale.`,
        free_endpoint: "/v1/decision?symbol=" + symbol,
      },
      503,
    );
  }
  const { record, hash } = await decisions.analyze(symbol, { mode: "RESEARCH_ONLY", execution: "PAPER" });
  c.set("proof", {
    sign: {
      payload_version: PAYLOAD_VERSION,
      query_ts: new Date().toISOString(),
      symbol,
      lynch_category: record.lynchCategory ?? "unknown",
      verdict: record.verdict,
      conviction_score: record.convictionScore,
      decision_hash: hash,
      // Signed, so the buyer can tell real analysis from a demo fixture.
      data_source: record.dataProvenance[0]?.source ?? fundamentals.sourceId,
    },
    narrative: {
      businessSummary: record.understandability.businessSummary,
      growthStory: record.understandability.growthStory,
    },
  });
  return c.json({ pending: true }); // replaced by finalizeProof after settlement
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DipBuyer x402 service on :${info.port}  network=${NETWORK}  payTo=${PAY_TO || "(unset)"}`);
  console.log(`  free:  GET /v1/decision?symbol=AAPL`);
  console.log(`  paid:  GET /v1/proof?symbol=AAPL  (${PRICE} USDC via x402, facilitator ${FACILITATOR})`);
});
