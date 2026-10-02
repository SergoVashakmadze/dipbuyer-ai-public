/**
 * Default research screener universe: liquid US large caps across every sector, so each idea
 * list has candidates. Hand-curated on purpose. The vendored S&P 500 membership file is a
 * backtest input whose licence forbids surfacing it through the API (packages/data/vendor/NOTICE.md).
 *
 * Kept small because every name costs a fundamentals fetch plus a price-history fetch on a cold
 * cache. Override with RESEARCH_UNIVERSE="AAPL,MSFT,...".
 */
export const DEFAULT_RESEARCH_UNIVERSE = [
  // Technology & communication
  "AAPL", "MSFT", "GOOGL", "META", "NVDA", "ADBE", "CRM", "INTC", "CSCO", "QCOM",
  // Consumer
  "AMZN", "NKE", "SBUX", "TGT", "KO", "PEP", "PG", "MCD",
  // Healthcare
  "JNJ", "PFE", "UNH", "CVS", "MRK", "ABBV",
  // Financials
  "JPM", "BAC", "V", "WFC",
  // Industrials, energy, materials, utilities, telecom
  "CAT", "UPS", "BA", "XOM", "CVX", "DOW", "NEE", "VZ",
];

export function researchUniverse(): string[] {
  const fromEnv = process.env.RESEARCH_UNIVERSE?.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s));
  return fromEnv && fromEnv.length > 0 ? [...new Set(fromEnv)] : DEFAULT_RESEARCH_UNIVERSE;
}
