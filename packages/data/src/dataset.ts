import { readFileSync } from "node:fs";
import type { Fundamentals } from "@dipbuyer/shared";
import { InMemoryFundamentals } from "./in-memory.js";

/**
 * File-backed fundamentals: point-in-time snapshots from an externally supplied dataset, run
 * through the SAME engine, record, hash and backtest as live data.
 *
 * Written ahead of the FCA Agentic Academy / Supercharged Sandbox, whose datasets are synthetic
 * or curated. Whatever arrives gets mapped into this one JSON shape by a small, reviewable
 * conversion script, instead of each dataset growing its own adapter.
 *
 * The dataset MUST declare its provenance. `synthetic: true` rewrites the source id to
 * `synthetic:<source>`, which isSyntheticSource() recognises, so the web app shows the demo-data
 * banner and x402 refuses to sell proofs built on it. There is no default: a dataset that does not
 * say whether it is synthetic is rejected rather than silently presented as real analysis.
 */
export interface FundamentalsDataset {
  /** Where the data came from, e.g. "fca-supercharged-sandbox/equities-v1". */
  source: string;
  synthetic: boolean;
  /** Free text: licence, retention and usage limits the provider attached. */
  licence?: string;
  snapshots: Fundamentals[];
}

const REQUIRED: ReadonlyArray<keyof Fundamentals> = ["symbol", "asOf"];

/**
 * Absent optional fields become null (unknown), never 0: the engine treats null as "not
 * evaluated", while 0 would be scored as a real observation.
 */
const UNKNOWN: Omit<Fundamentals, "symbol" | "asOf"> = {
  peRatio: null, epsGrowthPct: null, epsGrowthHistoryPct: [], dividendYieldPct: null, payoutRatio: null,
  debtToEquity: null, netCashPerShare: null, roePct: null, currentRatio: null, freeCashFlow: null,
  revenueGrowthPct: null, inventoryGrowthPct: null, marketCapUsd: null, salesUsd: null,
  institutionalOwnershipPct: null, institutionalOwnershipMedianPct: null, insiderNetBuying: null,
  fiveYearAvgPe: null, earningsCyclicality: null, distressed: null, hiddenAssetValueToMarketCap: null,
};

export function parseFundamentalsDataset(raw: unknown): { adapter: InMemoryFundamentals; dataset: FundamentalsDataset } {
  const d = raw as Partial<FundamentalsDataset> | null;
  if (!d || typeof d !== "object") throw new Error("dataset: not a JSON object");
  if (typeof d.source !== "string" || !d.source.trim()) throw new Error("dataset: `source` is required");
  if (typeof d.synthetic !== "boolean") {
    throw new Error("dataset: `synthetic` must be true or false — provenance is never assumed");
  }
  if (!Array.isArray(d.snapshots) || d.snapshots.length === 0) throw new Error("dataset: `snapshots` must be a non-empty array");

  const bySymbol = new Map<string, Fundamentals[]>();
  d.snapshots.forEach((s, i) => {
    for (const k of REQUIRED) {
      if (typeof s?.[k] !== "string" || !(s[k] as string)) throw new Error(`dataset: snapshot ${i} is missing \`${k}\``);
    }
    if (Number.isNaN(Date.parse(s.asOf))) throw new Error(`dataset: snapshot ${i} has an invalid asOf`);
    // Absent optional fields become null (unknown), never 0: the engine treats null as "not
    // evaluated", while 0 would be scored as a real observation.
    const full: Fundamentals = { ...UNKNOWN, ...(s as Partial<Fundamentals>), symbol: s.symbol.toUpperCase(), asOf: s.asOf };
    const list = bySymbol.get(full.symbol) ?? [];
    list.push(full);
    bySymbol.set(full.symbol, list);
  });

  const sourceId = d.synthetic ? `synthetic:${d.source}` : d.source;
  return {
    adapter: new InMemoryFundamentals(bySymbol, sourceId),
    dataset: { source: d.source, synthetic: d.synthetic, licence: d.licence, snapshots: d.snapshots },
  };
}

export function loadFundamentalsDataset(path: string) {
  return parseFundamentalsDataset(JSON.parse(readFileSync(path, "utf8")));
}
