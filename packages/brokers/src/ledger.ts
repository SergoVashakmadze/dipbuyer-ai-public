/**
 * Trade ledger and portfolio attribution: who put each dollar where.
 *
 * The broker reports one aggregated position per symbol, so it cannot say whether a holding came from
 * the agent's picks, the index core, or the investor's own orders. The ledger records every order the
 * app submits with its SOURCE; attribution replays it (average-cost lots per source per symbol) and
 * reconciles against the broker:
 *   - broker holds MORE than the ledger explains -> the excess is "unattributed" (positions opened
 *     before the ledger existed, or outside the app);
 *   - ledger explains MORE than the broker holds -> sources are scaled down pro rata (an order that
 *     was submitted but not filled, e.g. an async limit order that never executed).
 *
 * Pure: prices and positions are supplied by the caller.
 */

export type TradeSource = "self" | "agent" | "core";
export type Sleeve = TradeSource | "unattributed";

export interface LedgerEntry {
  id: string;
  ts: string;
  userId: string;
  source: TradeSource;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  status: string;
  brokerOrderId?: string;
  runId?: string;
}

export interface SleeveHolding {
  sleeve: Sleeve;
  qty: number;
  /** Cost of the qty still held (average-cost basis). */
  cost: number;
  value: number;
}

export interface SleeveSummary {
  sleeve: Sleeve;
  value: number;
  cost: number;
  unrealized: number;
  realized: number;
  positions: number;
}

export interface Attribution {
  bySymbol: Record<string, SleeveHolding[]>;
  sleeves: SleeveSummary[];
}

const FAILED = new Set(["rejected", "canceled", "cancelled", "expired", "failed"]);

export function attribute(
  entries: LedgerEntry[],
  positions: Array<{ symbol: string; qty: number; avgEntryPrice: number }>,
  priceOf: (symbol: string) => number,
): Attribution {
  // Replay the ledger oldest first: average-cost lots per (symbol, source), realized P&L on sells.
  const lots = new Map<string, Map<TradeSource, { qty: number; cost: number }>>();
  const realized: Record<Sleeve, number> = { self: 0, agent: 0, core: 0, unattributed: 0 };
  for (const e of [...entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    if (FAILED.has(e.status.toLowerCase()) || !(e.qty > 0)) continue;
    const sym = e.symbol.toUpperCase();
    const bySource = lots.get(sym) ?? new Map<TradeSource, { qty: number; cost: number }>();
    lots.set(sym, bySource);
    const lot = bySource.get(e.source) ?? { qty: 0, cost: 0 };
    bySource.set(e.source, lot);
    if (e.side === "buy") {
      lot.qty += e.qty;
      lot.cost += e.qty * e.price;
    } else {
      // A sell reduces its own source first; a remainder (e.g. the investor selling shares the agent
      // bought) comes out of the other sources pro rata, so no lot ever goes negative.
      let remaining = e.qty;
      const take = (l: { qty: number; cost: number }, q: number, source: TradeSource) => {
        const avg = l.qty > 0 ? l.cost / l.qty : 0;
        l.qty -= q;
        l.cost -= avg * q;
        realized[source] += (e.price - avg) * q;
      };
      const own = Math.min(remaining, lot.qty);
      if (own > 0) take(lot, own, e.source);
      remaining -= own;
      if (remaining > 0) {
        const others = [...bySource.entries()].filter(([s, l]) => s !== e.source && l.qty > 0);
        const pool = others.reduce((t, [, l]) => t + l.qty, 0);
        for (const [s, l] of others) take(l, Math.min(l.qty, (remaining * l.qty) / pool), s);
      }
    }
  }

  const bySymbol: Record<string, SleeveHolding[]> = {};
  const totals = new Map<Sleeve, SleeveSummary>();
  const add = (h: SleeveHolding) => {
    const s = totals.get(h.sleeve) ?? { sleeve: h.sleeve, value: 0, cost: 0, unrealized: 0, realized: realized[h.sleeve], positions: 0 };
    s.value += h.value;
    s.cost += h.cost;
    s.unrealized += h.value - h.cost;
    s.positions += 1;
    totals.set(h.sleeve, s);
  };

  for (const p of positions) {
    if (!(p.qty > 0)) continue;
    const sym = p.symbol.toUpperCase();
    const price = priceOf(sym);
    const ledger = [...(lots.get(sym)?.entries() ?? [])].filter(([, l]) => l.qty > 1e-9);
    const explained = ledger.reduce((t, [, l]) => t + l.qty, 0);
    const scale = explained > p.qty ? p.qty / explained : 1; // submitted but never filled
    const holdings: SleeveHolding[] = ledger.map(([sleeve, l]) => ({ sleeve, qty: l.qty * scale, cost: l.cost * scale, value: l.qty * scale * price }));
    const rest = p.qty - explained * scale;
    if (rest > 1e-9) holdings.push({ sleeve: "unattributed", qty: rest, cost: rest * p.avgEntryPrice, value: rest * price });
    bySymbol[sym] = holdings;
    holdings.forEach(add);
  }
  // Sleeves that sold out entirely still carry realized P&L.
  for (const s of ["self", "agent", "core"] as const) {
    if (!totals.has(s) && realized[s] !== 0) totals.set(s, { sleeve: s, value: 0, cost: 0, unrealized: 0, realized: realized[s], positions: 0 });
  }
  const order: Sleeve[] = ["core", "agent", "self", "unattributed"];
  return { bySymbol, sleeves: [...totals.values()].sort((a, b) => order.indexOf(a.sleeve) - order.indexOf(b.sleeve)) };
}

export interface PortfolioSnapshot {
  /** YYYY-MM-DD, one per day (the latest reading of the day wins). */
  date: string;
  equity: number;
  cash: number;
  sleeves: Partial<Record<Sleeve, number>>;
  /** Benchmark price at the snapshot, for the comparison line. */
  benchmark: number | null;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Equity and benchmark rebased to 100 at the first snapshot that has both. */
export function performanceSeries(snapshots: PortfolioSnapshot[]): Array<{ date: string; portfolio: number; benchmark: number | null }> {
  const sorted = [...snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  const base = sorted.find((s) => s.equity > 0);
  if (!base) return [];
  const bBase = sorted.find((s) => s.date >= base.date && s.benchmark && s.benchmark > 0)?.benchmark ?? null;
  return sorted
    .filter((s) => s.date >= base.date)
    .map((s) => ({
      date: s.date,
      portfolio: round4((s.equity / base.equity) * 100),
      benchmark: bBase && s.benchmark ? round4((s.benchmark / bBase) * 100) : null,
    }));
}
