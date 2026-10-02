import type { Fundamentals } from "@dipbuyer/shared";
import { DecisionService, InMemoryDecisionStore, createLlmUnderstandabilityProvider, type DecisionStore } from "@dipbuyer/agent";
import {
  AlpacaMarketData,
  FinancialDatasetsFundamentals,
  InMemoryFundamentals,
  loadFundamentalsDataset,
  SecEdgarFundamentals,
  type FundamentalsAdapter,
} from "@dipbuyer/data";
import { PrismaDecisionStore, createPrismaClient } from "../persistence/prisma-decision-store.js";

export const DECISION_SERVICE = "DECISION_SERVICE";
export const DECISION_STORE = "DECISION_STORE";

/** Minimal demo fundamentals so the API runs without API keys (dev only). */
function demoFundamentals(): Map<string, Fundamentals[]> {
  const mk = (symbol: string, pe: number, growth: number): Fundamentals =>
    ({ symbol, asOf: "2026-01-01T00:00:00Z", peRatio: pe, epsGrowthPct: growth, epsGrowthHistoryPct: [growth - 2, growth - 1, growth], dividendYieldPct: 0, payoutRatio: 0, debtToEquity: 0.2, netCashPerShare: 1, roePct: 18, currentRatio: 1.5, freeCashFlow: 1, revenueGrowthPct: growth + 3, inventoryGrowthPct: 5, marketCapUsd: 2e9, salesUsd: 1.5e9, institutionalOwnershipPct: 30, institutionalOwnershipMedianPct: 50, insiderNetBuying: true, fiveYearAvgPe: pe, earningsCyclicality: "low", distressed: false, hiddenAssetValueToMarketCap: null }) as Fundamentals;
  return new Map([
    ["AAPL", [mk("AAPL", 12, 25)]],
    ["MSFT", [mk("MSFT", 18, 15)]],
    ["RICH", [mk("RICH", 60, 25)]],
  ]);
}

/**
 * Builds the DecisionService from env: real financialdatasets.ai adapter when a key is present,
 * otherwise an in-memory demo so the API boots for local development.
 */
/**
 * Fundamentals source, in priority order:
 *
 *  1. financialdatasets.ai (paid) — richest: ships precomputed ratios plus institutional
 *     ownership and insider signals that EDGAR's financial statements do not carry.
 *  2. SEC EDGAR (free, keyless) — regulator-sourced with EXACT filing dates, so point-in-time
 *     is precise rather than the 90-day approximation the paid path needs. Ratios are derived
 *     locally; prices come from Alpaca when configured, else PE/market-cap stay null.
 *     US filers only.
 *  3. In-memory demo — last resort so the API still boots.
 *
 * EDGAR leaves insider/institutional fields null. That is safe: the Lynch scorer omits absent
 * criteria and renormalises by the weights actually present (score.ts), so verdicts stay valid
 * — just built on fewer signals than the paid path.
 */
function buildFundamentals(): FundamentalsAdapter {
  // 0. An explicitly supplied dataset file (e.g. FCA Supercharged Sandbox data) overrides every
  //    live source, so a sandbox run can never mix provider data into its results. The file
  //    declares whether it is synthetic; see packages/data/src/dataset.ts.
  const datasetPath = process.env.FUNDAMENTALS_DATASET_PATH;
  if (datasetPath) return loadFundamentalsDataset(datasetPath).adapter;

  const fdKey = process.env.FINANCIALDATASETS_API_KEY;
  if (fdKey) return new FinancialDatasetsFundamentals({ apiKey: fdKey });

  const ua = process.env.SEC_EDGAR_USER_AGENT;
  if (ua) {
    const id = process.env.ALPACA_KEY_ID;
    const secret = process.env.ALPACA_SECRET_KEY;
    return new SecEdgarFundamentals({
      userAgent: ua,
      marketData:
        id && secret
          ? new AlpacaMarketData({
              keyId: id,
              secretKey: secret,
              feed: (process.env.ALPACA_DATA_FEED as "iex" | "sip") ?? "iex",
            })
          : undefined,
    });
  }
  return new InMemoryFundamentals(demoFundamentals());
}

export function buildDecisionService(store: DecisionStore): DecisionService {
  const fundamentals = buildFundamentals();
  // LLM Lynch narrative (OpenAI-compatible; defaults to Groq). Env-gated — without a key the
  // service falls back to the permissive placeholder gate, so the deterministic verdict never breaks.
  const llmKey = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY;
  const understandabilityProvider = llmKey
    ? createLlmUnderstandabilityProvider({ apiKey: llmKey, baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL })
    : undefined;
  return new DecisionService({
    fundamentals,
    store,
    understandabilityProvider,
    modelId: process.env.LLM_MODEL ?? "deterministic-only",
    promptVersion: "0.1",
  });
}

export const decisionStoreProvider = {
  provide: DECISION_STORE,
  useFactory: async (): Promise<DecisionStore> => {
    if (process.env.DATABASE_URL) {
      try {
        return new PrismaDecisionStore(await createPrismaClient());
      } catch (err) {
        // Prisma client not generated / DB unreachable — fall back so the app still boots.
        console.warn("[decision-store] Postgres unavailable, using in-memory store:", (err as Error).message);
      }
    }
    return new InMemoryDecisionStore();
  },
};

export const decisionServiceProvider = {
  provide: DECISION_SERVICE,
  inject: [DECISION_STORE],
  useFactory: (store: DecisionStore) => buildDecisionService(store),
};
