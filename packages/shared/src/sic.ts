/**
 * SEC Standard Industrial Classification (SIC) → sector, and the D/E gate exemption.
 *
 * WHY SIC AND NOT GICS: `data.sec.gov/submissions/CIK##########.json` carries `sic` +
 * `sicDescription` on a document we already fetch to resolve the CIK, so this costs no new
 * provider, no licence and no vendored map. It is also the SEC's OWN classification — public
 * domain and auditable, which matters more for an FCA file than GICS precision does.
 *
 * ⚠️ SIC is coarser than GICS and is SELF-REPORTED by the filer. It is good enough to decide
 * "is this a bank" for a leverage exemption. Do not treat it as a precise taxonomy — the
 * concentration cap that consumes `sectorForSic` is a blunt risk control, not an attribution model.
 */

/**
 * SIC ranges → coarse sector. Order matters: FIRST MATCH WINS, so the narrow overrides below sit
 * ahead of the major-group defaults.
 *
 * The overrides exist because raw SIC major groups are useless for a CONCENTRATION cap. Group 35
 * is "Industrial and Commercial Machinery *and Computer Equipment*", so AAPL (3571) files
 * alongside Caterpillar; group 73 is "Business Services", so MSFT (7372) and GOOGL (7370) file
 * alongside staffing agencies. Since mega-cap tech IS the concentration risk this cap exists to
 * limit, letting it scatter across three unrelated buckets would defeat the control while
 * appearing to work. Computers, semiconductors and software are therefore pulled into one
 * `technology` bucket.
 */
const SECTOR_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  // --- narrow overrides, must precede their major groups ---
  [3570, 3579, "technology"], // computer & office equipment (AAPL 3571)
  [3600, 3699, "technology"], // electronics & semiconductors (NVDA/INTC/AMD 3674)
  [3661, 3669, "technology"], // comms equipment (inside 36xx; kept explicit for readability)
  [7370, 7379, "technology"], // computer programming & data processing (MSFT 7372, GOOGL 7370)
  // --- major-group defaults ---
  [100, 999, "agriculture"],
  [1000, 1499, "mining"],
  [1500, 1799, "construction"],
  [2000, 2199, "food_tobacco"],
  [2200, 2399, "textiles_apparel"],
  [2400, 2799, "paper_printing"],
  [2800, 2899, "chemicals_pharma"],
  [2900, 2999, "energy"],
  [3000, 3399, "materials"],
  [3400, 3599, "industrials"],
  [3700, 3799, "transport_equipment"],
  [3800, 3899, "instruments"],
  [3900, 3999, "manufacturing_other"],
  [4000, 4799, "transportation"],
  [4800, 4899, "communications"],
  [4900, 4999, "utilities"],
  [5000, 5199, "wholesale"],
  [5200, 5999, "retail"],
  [6000, 6799, "financials"],
  [7000, 7999, "services"],
  [8000, 8999, "health_services"],
  [9000, 9999, "public_admin"],
];

const parseSic = (sic: string | number | null | undefined): number | null => {
  if (sic === null || sic === undefined || sic === "") return null;
  const n = typeof sic === "number" ? sic : Number.parseInt(String(sic).trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 9999 ? n : null;
};

/** Coarse sector label for the concentration cap. `null` = unclassified (cap does not apply). */
export function sectorForSic(sic: string | number | null | undefined): string | null {
  const n = parseSic(sic);
  if (n === null) return null;
  for (const [lo, hi, sector] of SECTOR_RANGES) {
    if (n >= lo && n <= hi) return sector;
  }
  return null;
}

/**
 * Is this filer exempt from the debt-to-equity HARD REJECT?
 *
 * Lynch exempted financials explicitly — debt is a bank's raw material (*One Up on Wall Street*
 * ch.13). His single biggest winner was Fannie Mae at >10:1 leverage, and *Beating the Street*
 * devotes a chapter to savings-and-loans. Utilities are structurally levered by regulation and
 * were never the target of the "conservatively financed" preference either.
 *
 * These sectors still get screened — they simply need a solvency test D/E cannot provide, so the
 * ratio is scored (or omitted) rather than used to reject outright. See the fidelity notes.
 *
 *   6000-6799  Finance, Insurance, Real Estate (banks, thrifts, insurers, REITs)
 *   4900-4949  Utilities
 *
 * Unknown SIC returns FALSE: absent evidence of exemption the gate applies, because silently
 * exempting every company we failed to classify would delete the gate rather than scope it.
 */
export function isDebtGateExempt(sic: string | number | null | undefined): boolean {
  const n = parseSic(sic);
  if (n === null) return false;
  return (n >= 6000 && n <= 6799) || (n >= 4900 && n <= 4949);
}

/**
 * SEC SIC ranges for industries Lynch treats as CYCLICAL (*One Up on Wall Street* ch.7: autos,
 * airlines, tires, steel, chemicals, paper, oil, metals, and the heavy equipment that serves them).
 * Earnings in these swing with the economy, so a low P/E marks a PEAK and a high one a trough —
 * the earnings-growth PEG gate reads them backwards.
 *
 * Used only when the data source gives no explicit `earningsCyclicality` (SEC EDGAR never does).
 * Pharma (2830-2836) is carved out of chemicals. Deliberately conservative: a name missing from
 * this list is scored on its growth category, which is today's behaviour.
 */
const CYCLICAL_SIC_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1000, 1099], // metal mining
  [1311, 1311], // crude petroleum & natural gas
  [1381, 1389], // oil & gas field services
  [1520, 1531], // homebuilders
  [2600, 2631], // paper & pulp mills
  [2800, 2829], // industrial chemicals, plastics, synthetic materials (excludes pharma 2830-2836)
  [2860, 2899], // industrial organic, agricultural & misc chemicals (excludes soaps/cosmetics 2840-2844: PG is a staple)
  [2911, 2911], // petroleum refining
  [3011, 3011], // tires
  [3310, 3399], // steel & primary / secondary non-ferrous metals
  [3530, 3533], // construction, mining & oilfield machinery
  [3711, 3716], // motor vehicles & bodies
  [4512, 4513], // airlines & air courier
];

export function isCyclicalSic(sic: string | number | null | undefined): boolean {
  const n = parseSic(sic);
  if (n === null) return false;
  return CYCLICAL_SIC_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}
