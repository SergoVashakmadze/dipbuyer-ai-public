// Thin client for the DipBuyer AI API. Mirror of the DecisionRecord shape we render
// (kept local to avoid coupling the web build to workspace package internals).

export interface Criterion {
  name: string;
  value: number | string | null;
  threshold: string;
  result: "pass" | "fail" | "na";
  weight: number;
  note?: string;
}

export interface Understandability {
  passed: boolean;
  businessSummary?: string;
  growthStory?: string;
}

export interface DataProvenance {
  field: string;
  source: string;
  asOf: string;
}

export interface DecisionRecord {
  symbol: string;
  lynchCategory: string | null;
  convictionScore: number;
  verdict: "buy" | "hold" | "trim" | "sell" | "avoid" | "abstain";
  rationale: string;
  sellTriggers: string[];
  criteria: Criterion[];
  understandability?: Understandability | null;
  abstainReason: string | null;
  dataProvenance?: DataProvenance[];
}

/** Source ids that are NOT real market data — must be visibly flagged in the UI. */
const SYNTHETIC_SOURCES = ["in-memory-demo", "backtest-synthetic", "demo-market-data"];

/** The distinct synthetic sources behind a record, empty when it came from real data. */
export function syntheticSources(record: Pick<DecisionRecord, "dataProvenance">): string[] {
  return [
    ...new Set(
      (record.dataProvenance ?? [])
        .map((p) => p.source)
        .filter(isSyntheticSourceId),
    ),
  ];
}

export interface AnalyzeOutput {
  record: DecisionRecord;
  hash: string;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

export async function getDecision(symbol: string): Promise<AnalyzeOutput> {
  const res = await fetch(`${BASE}/decisions/${encodeURIComponent(symbol)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export async function screen(symbols: string[]): Promise<AnalyzeOutput[]> {
  const res = await fetch(`${BASE}/decisions/screen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Research views (GET /research/:symbol, GET /research/screener). Mirrors the API's
// ResearchView / ScreenerRow shapes. Fractions are 0..1; *Pct fields are whole percent.

export interface Fundamentals {
  symbol: string;
  asOf: string;
  peRatio: number | null;
  epsGrowthPct: number | null;
  epsGrowthHistoryPct: number[];
  dividendYieldPct: number | null;
  payoutRatio: number | null;
  debtToEquity: number | null;
  netCashPerShare: number | null;
  roePct: number | null;
  currentRatio: number | null;
  freeCashFlow: number | null;
  revenueGrowthPct: number | null;
  inventoryGrowthPct: number | null;
  marketCapUsd: number | null;
  salesUsd: number | null;
  insiderNetBuying: boolean | null;
  fiveYearAvgPe: number | null;
}

export interface PriceContext {
  price: number;
  asOf: string;
  high52w: number;
  low52w: number;
  drawdown: number;
  rangePosition: number | null;
  returns: { "1M": number | null; "3M": number | null; "6M": number | null; YTD: number | null; "1Y": number | null };
}

export interface Valuation {
  eps: number | null;
  lynchFairValue: number | null;
  grahamValue: number | null;
  intrinsicValue: number | null;
  upside: number | null;
  lynchRatio: number | null;
  aaaYieldPct: number;
}

export interface QualityProfile {
  overall: number | null;
  growth: number | null;
  profitability: number | null;
  health: number | null;
  capitalAllocation: number | null;
  momentum: number | null;
}

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
  verdict: DecisionRecord["verdict"];
  convictionScore: number;
  lynchCategory: string | null;
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

export function isSyntheticSourceId(source: string): boolean {
  return SYNTHETIC_SOURCES.includes(source) || source.startsWith("synthetic:");
}

export async function getResearch(symbol: string): Promise<ResearchView> {
  const res = await fetch(`${BASE}/research/${encodeURIComponent(symbol)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export async function getScreener(): Promise<ScreenerResult> {
  const res = await fetch(`${BASE}/research/screener`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
