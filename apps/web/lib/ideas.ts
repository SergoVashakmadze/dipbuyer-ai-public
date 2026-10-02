import type { ScreenerRow } from "./api";

const has = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);

export interface Idea {
  id: string;
  label: string;
  description: string;
  filter: (r: ScreenerRow) => boolean;
  sort?: (a: ScreenerRow, b: ScreenerRow) => number;
  /** Accent hue class and short tag for the idea card. */
  hue: string;
  tag: string;
}

const byDesc = (f: (r: ScreenerRow) => number | null) => (a: ScreenerRow, b: ScreenerRow) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity);

/**
 * Idea lists over the screened universe. Every list starts from the engine's verdicts and
 * adds one piece of descriptive evidence; none of them overrides a verdict.
 */
export const IDEAS: Idea[] = [
  {
    id: "dip-buys",
    hue: "hue-violet",
    tag: "Dip",
    label: "Dip buys",
    description: "Lynch buy verdicts trading at least 15% below their 52-week high.",
    filter: (r) => r.verdict === "buy" && has(r.drawdown) && r.drawdown >= 0.15,
    sort: byDesc((r) => r.drawdown),
  },
  {
    id: "buys",
    hue: "hue-emerald",
    tag: "Buy",
    label: "All buy verdicts",
    description: "Every name the Lynch engine rates a buy, highest conviction first.",
    filter: (r) => r.verdict === "buy",
    sort: byDesc((r) => r.convictionScore),
  },
  {
    id: "undervalued",
    hue: "hue-sky",
    tag: "Value",
    label: "Below intrinsic value",
    description: "Price at least 20% below the mean of the Lynch and Graham models.",
    filter: (r) => has(r.upside) && r.upside >= 0.2,
    sort: byDesc((r) => r.upside),
  },
  {
    id: "lynch-bargains",
    hue: "hue-amber",
    tag: "Bargain",
    label: "Lynch bargains",
    description: "(Growth + yield) / P/E of 2 or more, the level Lynch looked for.",
    filter: (r) => has(r.lynchRatio) && r.lynchRatio >= 2,
    sort: byDesc((r) => r.lynchRatio),
  },
  {
    id: "quality-on-sale",
    hue: "hue-rose",
    tag: "Quality",
    label: "Quality on sale",
    description: "Quality profile 6.5+ and at least 15% below the 52-week high, whatever the verdict.",
    filter: (r) => has(r.quality) && r.quality >= 6.5 && has(r.drawdown) && r.drawdown >= 0.15,
    sort: byDesc((r) => r.drawdown),
  },
  {
    id: "near-lows",
    hue: "hue-violet",
    tag: "Contrarian",
    label: "Near 52-week lows",
    description: "At least 25% below the 52-week high. Falling knives included: check the verdict.",
    filter: (r) => has(r.drawdown) && r.drawdown >= 0.25,
    sort: byDesc((r) => r.drawdown),
  },
  {
    id: "dividend",
    hue: "hue-emerald",
    tag: "Income",
    label: "Dividend value",
    description: "Yield of 2.5%+ with a hold or buy verdict.",
    filter: (r) => has(r.dividendYieldPct) && r.dividendYieldPct >= 2.5 && (r.verdict === "buy" || r.verdict === "hold"),
    sort: byDesc((r) => r.dividendYieldPct),
  },
  {
    id: "fortress",
    hue: "hue-sky",
    tag: "Safety",
    label: "Fortress balance sheet",
    description: "Financial health score of 8 or more.",
    filter: (r) => has(r.health) && r.health >= 8,
    sort: byDesc((r) => r.health),
  },
  { id: "all",
    hue: "hue-amber",
    tag: "Universe", label: "Whole universe", description: "Every screened name.", filter: () => true, sort: byDesc((r) => r.convictionScore) },
];

