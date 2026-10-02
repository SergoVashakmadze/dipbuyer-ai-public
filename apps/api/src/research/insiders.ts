import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";

/** One officer/director open-market purchase (build-insider-recent.mjs output row). */
export interface InsiderPurchase {
  accession: string;
  cik: string;
  ticker: string;
  company: string;
  filed: string;
  tradeDate: string;
  insider: string;
  title: string;
  isDirector: boolean;
  isOfficer: boolean;
  shares: number;
  price: number;
  usd: number;
}

export interface InsiderCompany {
  ticker: string;
  company: string;
  purchases: number;
  insiders: number;
  totalUsd: number;
  lastFiled: string;
  /** True when a CEO, CFO, president or chair bought: the purchases Lynch weighted most. */
  topExecutiveBought: boolean;
  largest: Pick<InsiderPurchase, "insider" | "title" | "usd" | "tradeDate" | "filed">;
  recent: Array<Pick<InsiderPurchase, "insider" | "title" | "usd" | "shares" | "price" | "tradeDate" | "filed">>;
}

const TOP_EXEC = /\b(CEO|chief executive|CFO|chief financial|president|chair)/i;

/**
 * Purchases per company over the window, most recent buying first. Several transactions in one filing
 * (a buy split across prices) count as one purchase; `insiders` counts distinct people, because
 * cluster buying by several insiders says more than one person buying often.
 */
export function aggregateInsiders(rows: InsiderPurchase[], sinceIso: string, minUsd = 0): InsiderCompany[] {
  const by = new Map<string, InsiderPurchase[]>();
  for (const r of rows) {
    if (r.filed < sinceIso || !r.ticker) continue;
    (by.get(r.ticker) ?? by.set(r.ticker, []).get(r.ticker)!).push(r);
  }
  const out: InsiderCompany[] = [];
  for (const [ticker, list] of by) {
    const totalUsd = list.reduce((t, r) => t + r.usd, 0);
    if (totalUsd < minUsd) continue;
    const byFiling = new Map<string, InsiderPurchase[]>();
    for (const r of list) (byFiling.get(r.accession) ?? byFiling.set(r.accession, []).get(r.accession)!).push(r);
    const filings = [...byFiling.values()].map((f) => ({
      ...f[0]!,
      usd: f.reduce((t, r) => t + r.usd, 0),
      shares: f.reduce((t, r) => t + r.shares, 0),
      price: f.reduce((t, r) => t + r.shares, 0) > 0 ? f.reduce((t, r) => t + r.usd, 0) / f.reduce((t, r) => t + r.shares, 0) : f[0]!.price,
    }));
    filings.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : b.usd - a.usd));
    const largest = [...filings].sort((a, b) => b.usd - a.usd)[0]!;
    out.push({
      ticker,
      company: list[0]!.company,
      purchases: filings.length,
      insiders: new Set(list.map((r) => r.insider)).size,
      totalUsd,
      lastFiled: filings[0]!.filed,
      topExecutiveBought: list.some((r) => r.isOfficer && TOP_EXEC.test(r.title)),
      largest: { insider: largest.insider, title: largest.title, usd: largest.usd, tradeDate: largest.tradeDate, filed: largest.filed },
      recent: filings.slice(0, 5).map(({ insider, title, usd, shares, price, tradeDate, filed }) => ({ insider, title, usd, shares, price, tradeDate, filed })),
    });
  }
  return out.sort((a, b) => (a.lastFiled < b.lastFiled ? 1 : a.lastFiled > b.lastFiled ? -1 : b.totalUsd - a.totalUsd));
}

/** Where build-insider-recent.mjs writes. Re-read when the file changes, so a daily rebuild shows up. */
export const insiderDataPath = () => process.env.INSIDER_RECENT_PATH || join(homedir(), "dipbuyer-data", "insider-recent.json");
const dataPath = insiderDataPath;
let cached: { mtimeMs: number; rows: InsiderPurchase[] } | null = null;
export function loadInsiderPurchases(): { rows: InsiderPurchase[]; updatedAt: string | null } {
  try {
    const st = statSync(dataPath());
    if (!cached || cached.mtimeMs !== st.mtimeMs) cached = { mtimeMs: st.mtimeMs, rows: JSON.parse(readFileSync(dataPath(), "utf8")) as InsiderPurchase[] };
    return { rows: cached.rows, updatedAt: new Date(st.mtimeMs).toISOString() };
  } catch {
    return { rows: [], updatedAt: null };
  }
}

/** GET /insiders?days=90&minUsd=0 — recent officer/director open-market buying in S&P 500 companies. Public research. */
@Controller("insiders")
export class InsidersController {
  @Public()
  @Get()
  list(@Query("days") days?: string, @Query("minUsd") minUsd?: string) {
    const d = days === undefined ? 90 : Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new BadRequestException("days must be 1-365");
    const min = minUsd === undefined ? 0 : Number(minUsd);
    if (!(min >= 0)) throw new BadRequestException("minUsd must be >= 0");
    const { rows, updatedAt } = loadInsiderPurchases();
    const since = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    return {
      since,
      updatedAt,
      source: "SEC EDGAR Form 4 (daily filings), S&P 500 issuers, officer and director open-market purchases (code P)",
      companies: aggregateInsiders(rows, since, min),
    };
  }
}
