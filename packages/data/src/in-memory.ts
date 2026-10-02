import type { Fundamentals } from "@dipbuyer/shared";
import type { FundamentalsAdapter, MarketDataAdapter, PriceBar } from "./index.js";

/**
 * In-memory adapters for tests, demos and the backtest harness. They ENFORCE point-in-time
 * discipline: never return data dated after the requested `asOf` clock (no look-ahead).
 * Real adapters (Alpaca, financialdatasets.ai) must preserve the same contract.
 */
export class InMemoryFundamentals implements FundamentalsAdapter {
  /**
   * Synthetic by construction — callers may override for a backtest fed from a real
   * historical export, but the default must stay honest about being demo data.
   */
  readonly sourceId: string;

  /** symbol -> snapshots (any order; filtered/sorted on read). */
  constructor(
    private readonly snapshots: Map<string, Fundamentals[]>,
    sourceId = "in-memory-demo",
  ) {
    this.sourceId = sourceId;
  }

  async getFundamentals(symbol: string, asOf?: string): Promise<Fundamentals> {
    const all = this.snapshots.get(symbol);
    if (!all || all.length === 0) throw new Error(`No fundamentals for ${symbol}`);
    const clock = asOf ?? "9999-12-31T23:59:59Z";
    const eligible = all
      .filter((s) => s.asOf <= clock) // POINT-IN-TIME: nothing from the future
      .sort((a, b) => (a.asOf < b.asOf ? 1 : -1)); // newest eligible first
    const latest = eligible[0];
    if (!latest) throw new Error(`No fundamentals for ${symbol} as of ${clock}`);
    return latest;
  }
}

export class InMemoryMarketData implements MarketDataAdapter {
  /** symbol -> bars (ascending by ts). */
  constructor(private readonly bars: Map<string, PriceBar[]>) {}

  async getBars(symbol: string, from: string, to: string): Promise<PriceBar[]> {
    return (this.bars.get(symbol) ?? []).filter((b) => b.ts >= from && b.ts <= to);
  }

  async getLatestPrice(symbol: string, asOf?: string): Promise<number> {
    const clock = asOf ?? "9999-12-31T23:59:59Z";
    const eligible = (this.bars.get(symbol) ?? []).filter((b) => b.ts <= clock);
    const last = eligible.at(-1);
    if (!last) throw new Error(`No price for ${symbol} as of ${clock}`);
    return last.close;
  }
}
