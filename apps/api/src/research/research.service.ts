import type { AnalyzeOptions, AnalyzeOutput, DecisionService } from "@dipbuyer/agent";
import type { MarketDataAdapter } from "@dipbuyer/data";
import type { Fundamentals, LynchCategory, RuntimeMode, Verdict } from "@dipbuyer/shared";
import {
  priceContext,
  qualityProfile,
  valuation,
  type PriceContext,
  type QualityProfile,
  type Valuation,
} from "@dipbuyer/strategy";

/**
 * Research views: the Lynch decision plus the evidence around it (price context, fair-value
 * models, quality profile). The verdict is the engine's, unchanged. Everything else is
 * descriptive and labelled with its source.
 */

export interface Provenance {
  field: string;
  source: string;
  asOf: string | null;
}

export interface ResearchView {
  symbol: string;
  decision: AnalyzeOutput;
  fundamentals: Fundamentals;
  price: PriceContext | null;
  valuation: Valuation;
  quality: QualityProfile;
  provenance: Provenance[];
}

export interface ScreenerRow {
  symbol: string;
  verdict: Verdict;
  convictionScore: number;
  lynchCategory: LynchCategory | null;
  price: number | null;
  drawdown: number | null;
  return1Y: number | null;
  intrinsicValue: number | null;
  upside: number | null;
  lynchRatio: number | null;
  peRatio: number | null;
  epsGrowthPct: number | null;
  dividendYieldPct: number | null;
  roePct: number | null;
  debtToEquity: number | null;
  marketCapUsd: number | null;
  quality: number | null;
  health: number | null;
  sources: string[];
}

export interface ScreenerResult {
  rows: ScreenerRow[];
  universe: string[];
  unavailable: string[];
  generatedAt: string;
}

export interface ResearchServiceOptions {
  priceSourceId: string;
  universe: () => string[];
  now?: () => Date;
  cacheTtlMs?: number;
  concurrency?: number;
}

const DAY_MS = 86_400_000;
/** A little over a year, so the 1Y return and 52-week range have a base bar. */
const HISTORY_DAYS = 380;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export class ResearchService {
  private cache: { at: number; result: Promise<ScreenerResult> } | null = null;

  constructor(
    private readonly decisions: DecisionService,
    private readonly market: MarketDataAdapter,
    private readonly opts: ResearchServiceOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private analyzeOptions(persist: boolean): AnalyzeOptions {
    return { mode: (process.env.RUNTIME_MODE as RuntimeMode) ?? "RESEARCH_ONLY", execution: "PAPER", persist };
  }

  private async price(symbol: string): Promise<PriceContext | null> {
    const to = this.now();
    const from = new Date(to.getTime() - HISTORY_DAYS * DAY_MS);
    try {
      const bars = await this.market.getBars(symbol, iso(from), iso(to), "1Day");
      return priceContext(bars.map((b) => ({ ts: b.ts, close: b.close })));
    } catch {
      // Price history is supporting evidence; its absence must not hide the verdict.
      return null;
    }
  }

  /** One symbol. `persist` records the decision in the audit store, as GET /decisions/:symbol does. */
  async view(symbol: string, persist = true): Promise<ResearchView> {
    const [analysis, price] = await Promise.all([
      this.decisions.analyzeWithInputs(symbol, this.analyzeOptions(persist)),
      this.price(symbol),
    ]);
    const { output, fundamentals, sourceId } = analysis;
    const px = price?.price ?? null;
    return {
      symbol,
      decision: output,
      fundamentals,
      price,
      valuation: valuation(fundamentals, px),
      quality: qualityProfile(fundamentals, price),
      provenance: [
        { field: "fundamentals", source: sourceId, asOf: fundamentals.asOf },
        { field: "price", source: price ? this.opts.priceSourceId : "unavailable", asOf: price?.asOf ?? null },
      ],
    };
  }

  /** The universe screen, shared by every caller for cacheTtlMs. Failed names are listed, not hidden. */
  screener(): Promise<ScreenerResult> {
    const ttl = this.opts.cacheTtlMs ?? 30 * 60_000;
    const nowMs = this.now().getTime();
    if (this.cache && nowMs - this.cache.at < ttl) return this.cache.result;
    const result = this.buildScreener().catch((err) => {
      this.cache = null; // never cache a failure
      throw err;
    });
    this.cache = { at: nowMs, result };
    return result;
  }

  private async buildScreener(): Promise<ScreenerResult> {
    const universe = this.opts.universe();
    const views = await mapLimit(universe, this.opts.concurrency ?? 3, (s) =>
      this.view(s, false).catch((err: unknown) => {
        // Listed in `unavailable` for the page; the reason goes to the log, not /dev/null.
        console.warn(`[research] ${s} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
    );
    const rows: ScreenerRow[] = [];
    const unavailable: string[] = [];
    views.forEach((v, i) => {
      if (!v) {
        unavailable.push(universe[i]!);
        return;
      }
      const r = v.decision.record;
      const f = v.fundamentals;
      rows.push({
        symbol: v.symbol,
        verdict: r.verdict,
        convictionScore: r.convictionScore,
        lynchCategory: r.lynchCategory,
        price: v.price?.price ?? null,
        drawdown: v.price?.drawdown ?? null,
        return1Y: v.price?.returns["1Y"] ?? null,
        intrinsicValue: v.valuation.intrinsicValue,
        upside: v.valuation.upside,
        lynchRatio: v.valuation.lynchRatio,
        peRatio: f.peRatio,
        epsGrowthPct: f.epsGrowthPct,
        dividendYieldPct: f.dividendYieldPct,
        roePct: f.roePct,
        debtToEquity: f.debtToEquity,
        marketCapUsd: f.marketCapUsd,
        quality: v.quality.overall,
        health: v.quality.health,
        sources: [...new Set(v.provenance.map((p) => p.source))],
      });
    });
    return { rows, universe, unavailable, generatedAt: iso(this.now()) };
  }
}
