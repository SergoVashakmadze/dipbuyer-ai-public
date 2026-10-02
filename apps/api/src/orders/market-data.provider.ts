import type { MarketDataAdapter, PriceBar } from "@dipbuyer/data";
import { AlpacaMarketData } from "@dipbuyer/data";

export const MARKET_DATA = "MARKET_DATA";

const DAY_MS = 86_400_000;

/**
 * Demo price source so market orders, portfolio valuation and research pages work without
 * Alpaca keys. SYNTHETIC: its source id is in SYNTHETIC_SOURCE_IDS and the web app flags it.
 * Bars are a deterministic walk ending at the demo price, so a page renders identically on
 * every load instead of inventing a new chart each time.
 */
export class DemoMarketData implements MarketDataAdapter {
  readonly sourceId = "demo-market-data";
  private readonly prices: Record<string, number> = { AAPL: 190, MSFT: 420, RICH: 300 };

  async getBars(symbol: string, from: string, to: string): Promise<PriceBar[]> {
    const end = Date.parse(to);
    const start = Date.parse(from);
    if (Number.isNaN(end) || Number.isNaN(start) || end < start) return [];
    const last = await this.getLatestPrice(symbol);
    let seed = [...symbol.toUpperCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2_147_483_647, 17);
    const rand = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const days = Math.floor((end - start) / DAY_MS);
    // Walk backwards from the latest price so the final bar equals getLatestPrice().
    const closes: number[] = [last];
    for (let i = 1; i <= days; i++) closes.push(Math.max(1, closes[i - 1]! / (1 + (rand() - 0.49) * 0.03)));
    closes.reverse();
    return closes.map((close, i) => ({
      symbol: symbol.toUpperCase(),
      ts: new Date(end - (days - i) * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    }));
  }

  async getLatestPrice(symbol: string): Promise<number> {
    return this.prices[symbol.toUpperCase()] ?? 100;
  }
}

function alpacaConfig() {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const feed = (process.env.ALPACA_DATA_FEED || "iex") as "iex" | "sip";
  return keyId && secretKey ? { keyId, secretKey, feed } : null;
}

/** Provenance id for whichever price source marketDataProvider builds. */
export function marketDataSourceId(): string {
  const cfg = alpacaConfig();
  return cfg ? `alpaca-${cfg.feed}` : "demo-market-data";
}

/** Alpaca market data when keys are present, else the demo source. */
export const marketDataProvider = {
  provide: MARKET_DATA,
  useFactory: (): MarketDataAdapter => {
    const cfg = alpacaConfig();
    return cfg ? new AlpacaMarketData(cfg) : new DemoMarketData();
  },
};
