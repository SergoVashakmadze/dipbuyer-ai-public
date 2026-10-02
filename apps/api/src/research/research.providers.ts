import type { DecisionService } from "@dipbuyer/agent";
import { AlpacaMarketData, type MarketDataAdapter } from "@dipbuyer/data";
import { DECISION_SERVICE } from "../decision/decision.providers.js";
import { MARKET_DATA, marketDataSourceId } from "../orders/market-data.provider.js";
import { ResearchService } from "./research.service.js";
import { researchUniverse } from "./universe.js";

export const RESEARCH_SERVICE = "RESEARCH_SERVICE";

export const researchServiceProvider = {
  provide: RESEARCH_SERVICE,
  inject: [DECISION_SERVICE, MARKET_DATA],
  useFactory: (decisions: DecisionService, market: MarketDataAdapter) =>
    new ResearchService(decisions, researchPrices(market), {
      priceSourceId: marketDataSourceId(),
      universe: researchUniverse,
      cacheTtlMs: Number(process.env.RESEARCH_SCREENER_TTL_MS ?? 30 * 60_000),
    }),
};

/**
 * Price HISTORY for research pages must be split- and dividend-adjusted. The shared provider is
 * raw (right for orders and for P/E against as-filed EPS), but a raw series turns NVDA's 2024 10:1
 * split into a 90% "drawdown" and a -90% 1Y return. The latest adjusted close equals the latest raw
 * close, so the page's price and valuation are unaffected.
 */
function researchPrices(shared: MarketDataAdapter): MarketDataAdapter {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) return shared; // demo source has no corporate actions
  return new AlpacaMarketData({
    keyId,
    secretKey,
    feed: (process.env.ALPACA_DATA_FEED || "iex") as "iex" | "sip",
    adjustment: "all",
  });
}
