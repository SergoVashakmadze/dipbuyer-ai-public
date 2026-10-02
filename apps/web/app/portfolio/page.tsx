"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { useInvestorId } from "../../components/use-investor-id";
import { protectPage } from "../../components/protect-page";
import { hueFor } from "../../components/research-ui";

type Sleeve = "core" | "agent" | "self" | "unattributed";

interface Holding {
  sleeve: Sleeve;
  qty: number;
  cost: number;
  value: number;
}
interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
  bySource?: Holding[];
}
interface SleeveSummary {
  sleeve: Sleeve;
  value: number;
  cost: number;
  unrealized: number;
  realized: number;
  positions: number;
}
interface Portfolio {
  cash: number;
  positions: Position[];
  sleeves?: SleeveSummary[];
  benchmarkSymbol?: string;
}
interface Allocation {
  coreSymbol: string;
  satellitePct: number;
  cashFloorPct: number;
}
interface Performance {
  benchmarkSymbol: string;
  series: Array<{ date: string; portfolio: number; benchmark: number | null }>;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

const SLEEVE_LABEL: Record<Sleeve, string> = {
  core: "Index core",
  agent: "Agent picks",
  self: "Your picks",
  unattributed: "Other holdings",
};
const SLEEVE_HINT: Record<Sleeve, string> = {
  core: "The index ETF the agent keeps spare money in",
  agent: "Lynch picks the agent proposed and you or it placed",
  self: "Orders you placed yourself",
  unattributed: "Held before tracking began, or placed outside the app",
};

const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signedUsd = (v: number) => `${v > 0 ? "+" : ""}${usd(v)}`;
const tone = (v: number) => (v > 0 ? "var(--success)" : v < 0 ? "var(--danger)" : undefined);

function PortfolioPage() {
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [alloc, setAlloc] = useState<Allocation | null>(null);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ symbol: "AAPL", side: "buy", qty: "10", limitPrice: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const authedFetch = useAuthedFetch();
  const investorId = useInvestorId();

  const load = useCallback(async () => {
    try {
      const r = await authedFetch(`${BASE}/portfolio`, { cache: "no-store" });
      if (!r.ok) throw new Error(`API ${r.status}`);
      setPf(await r.json());
      setError(null);
      // Policy and history are extras: the page still works on an API without them.
      const [s, p] = await Promise.all([
        authedFetch(`${BASE}/agent/status`, { cache: "no-store" }).catch(() => null),
        authedFetch(`${BASE}/portfolio/performance`, { cache: "no-store" }).catch(() => null),
      ]);
      if (s?.ok) setAlloc(((await s.json()) as { allocation?: Allocation }).allocation ?? null);
      if (p?.ok) setPerf((await p.json()) as Performance);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed — is the API on :3001?");
    }
  }, [authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function placeOrder() {
    setMsg(null);
    try {
      const r = await authedFetch(`${BASE}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: form.symbol,
          side: form.side,
          qty: Number(form.qty),
          // Blank limit = the current market price, fetched by the API.
          ...(form.limitPrice.trim() ? { limitPrice: Number(form.limitPrice) } : {}),
          userId: investorId,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.message ?? body.error?.message ?? `API ${r.status}`);
      const funded = body.fundedFromCore as { symbol: string; notional: number } | undefined;
      setMsg(
        `Order ${body.status}. It is tracked under "Your picks".` +
          (funded ? ` Paid for by selling ${usd(funded.notional)} of the ${funded.symbol} core.` : ""),
      );
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Order failed");
    }
  }

  const coreSymbol = alloc?.coreSymbol ?? pf?.benchmarkSymbol ?? "SPY";
  const invested = pf ? pf.positions.reduce((t, p) => t + p.marketValue, 0) : 0;
  const pnl = pf ? pf.positions.reduce((t, p) => t + p.unrealizedPl, 0) : 0;
  const total = pf ? pf.cash + invested : 0;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const fmtPct = (v: number) => `${v.toFixed(1)}%`;

  // Who owns what. With a ledger the API attributes every share; without one (older API) fall back
  // to "the core ETF is core, everything else is a pick".
  const sleeveValue = useMemo(() => {
    const v: Record<Sleeve, number> = { core: 0, agent: 0, self: 0, unattributed: 0 };
    if (pf?.sleeves?.length) for (const s of pf.sleeves) v[s.sleeve] += s.value;
    else if (pf)
      for (const p of pf.positions) {
        if (p.symbol === coreSymbol) v.core += p.marketValue;
        else v.agent += p.marketValue;
      }
    return v;
  }, [pf, coreSymbol]);

  const ordered = pf ? [...pf.positions].sort((a, b) => (a.symbol === coreSymbol ? -1 : b.symbol === coreSymbol ? 1 : b.marketValue - a.marketValue)) : [];
  const segments: Array<[Sleeve | "cash", number]> = [
    ["core", sleeveValue.core],
    ["agent", sleeveValue.agent],
    ["self", sleeveValue.self],
    ["unattributed", sleeveValue.unattributed],
    ["cash", pf?.cash ?? 0],
  ];

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Portfolio</span>
        <h1>Paper portfolio</h1>
        <p>
          One account, three ways in: an index core ({coreSymbol}), the agent&apos;s Lynch picks, and anything you choose to buy yourself. Each is
          tracked separately so you can see which one is earning its keep.
        </p>
      </div>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {pf && (
        <>
          <div className="card stat-band" style={{ marginTop: 16 }}>
            <div>
              <div className="v mono">{usd(total)}</div>
              <div className="l">Total value</div>
            </div>
            <div>
              <div className="v mono">{usd(pf.cash)}</div>
              <div className="l">Cash</div>
            </div>
            <div>
              <div className="v mono">{usd(invested)}</div>
              <div className="l">Invested</div>
            </div>
            <div>
              <div className="v mono" style={{ color: tone(pnl) }}>{signedUsd(pnl)}</div>
              <div className="l">Unrealised P&amp;L</div>
            </div>
          </div>

          {total > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>Where the money is</div>
              <div className="split-bar" role="img" aria-label={segments.map(([k, v]) => `${k === "cash" ? "Cash" : SLEEVE_LABEL[k]} ${fmtPct(pct(v))}`).join(", ")}>
                {segments.map(([k, v]) => (v > 0 ? <span key={k} className={k} style={{ width: `${pct(v)}%` }} /> : null))}
              </div>
              <div className="split-legend">
                {segments
                  .filter(([k, v]) => v > 0 || k === "core" || k === "cash")
                  .map(([k, v]) => (
                    <span key={k} className={k}>
                      <i />
                      {k === "cash" ? "Cash" : k === "core" ? `${SLEEVE_LABEL.core} (${coreSymbol})` : SLEEVE_LABEL[k]} <b className="mono">{fmtPct(pct(v))}</b>
                      {k === "cash" && alloc && <span className="muted"> · floor {alloc.cashFloorPct}%</span>}
                      {k === "agent" && alloc && <span className="muted"> · target up to {alloc.satellitePct}%</span>}
                    </span>
                  ))}
              </div>
              {alloc && pct(pf.cash) > alloc.cashFloorPct + 5 && (
                <p className="muted small" style={{ margin: "10px 0 0" }}>
                  Cash is well above the floor. Run the agent to put it in the core; the backtest assumes spare cash sits in {coreSymbol}.
                </p>
              )}
            </div>
          )}

          <div className="two-col" style={{ marginTop: 20 }}>
            <div className="card">
              <div className="card-title">Performance vs {perf?.benchmarkSymbol ?? coreSymbol}</div>
              <PerformanceChart perf={perf} benchmark={perf?.benchmarkSymbol ?? coreSymbol} />
            </div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="table-head">
                <div className="card-title" style={{ margin: 0 }}>By source</div>
                <span className="muted small">average cost</span>
              </div>
              {pf.sleeves?.length ? (
                <div className="table-wrap">
                  <table className="data-table" style={{ minWidth: 0 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Source</th>
                        <th>Value</th>
                        <th>Unrealised</th>
                        <th>Realised</th>
                        <th>Return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pf.sleeves.map((s) => {
                        const ret = s.cost > 0 ? ((s.unrealized + s.realized) / s.cost) * 100 : null;
                        return (
                          <tr key={s.sleeve}>
                            <td>
                              <b>{SLEEVE_LABEL[s.sleeve]}</b>
                              <div className="muted small">{SLEEVE_HINT[s.sleeve]}</div>
                            </td>
                            <td className="mono num">{usd(s.value)}</td>
                            <td className="mono num" style={{ color: tone(s.unrealized) }}>{signedUsd(s.unrealized)}</td>
                            <td className="mono num" style={{ color: tone(s.realized) }}>{signedUsd(s.realized)}</td>
                            <td className="mono num" style={{ color: tone(ret ?? 0) }}>{ret === null ? "—" : `${ret > 0 ? "+" : ""}${ret.toFixed(2)}%`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small" style={{ padding: "0 24px 20px" }}>
                  Nothing tracked yet. Every order placed from now on, by you or the agent, is recorded with its source.
                </p>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 20, padding: 0, overflow: "hidden" }}>
            <div className="table-head">
              <div className="card-title" style={{ margin: 0 }}>Positions</div>
              <span className="muted small">{pf.positions.length} open</span>
            </div>
            {pf.positions.length === 0 ? (
              <p className="muted" style={{ padding: "0 24px 20px" }}>No open positions.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table" style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th style={{ textAlign: "left" }}>Held for</th>
                      <th>Quantity</th>
                      <th>Avg entry</th>
                      <th>Market value</th>
                      <th>Unrealised P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map((p) => (
                      <tr key={p.symbol}>
                        <td>
                          <div className="company-cell">
                            <span className={`ticker-logo ${hueFor(p.symbol)}`} aria-hidden>{p.symbol.slice(0, 4)}</span>
                            {p.symbol === coreSymbol ? <span className="symbol">{p.symbol}</span> : <a className="symbol" href={`/stock/${p.symbol}`}>{p.symbol}</a>}
                          </div>
                        </td>
                        <td className="small">
                          {p.bySource?.length
                            ? p.bySource.map((h) => (
                                <span key={h.sleeve} className={`source-chip ${h.sleeve}`} title={`${h.qty.toFixed(4).replace(/\.?0+$/, "")} shares`}>
                                  {SLEEVE_LABEL[h.sleeve]}
                                  {p.bySource!.length > 1 ? ` ${Math.round((h.qty / p.qty) * 100)}%` : ""}
                                </span>
                              ))
                            : <span className="muted">{p.symbol === coreSymbol ? SLEEVE_LABEL.core : "—"}</span>}
                        </td>
                        <td className="mono num">{p.qty}</td>
                        <td className="mono num">{usd(p.avgEntryPrice)}</td>
                        <td className="mono num">{usd(p.marketValue)}</td>
                        <td className="mono num" style={{ color: tone(p.unrealizedPl) }}>{signedUsd(p.unrealizedPl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">Invest on your own</div>
        <p className="muted small">
          Demonstration of buying or selling any US stock yourself, alongside the agent. Your orders pass the same risk guardrails and are tracked as &quot;Your picks&quot;,
          so you can compare your choices with the agent&apos;s. When cash is short, the buy is paid for by selling just enough of the {coreSymbol} core. Check the <a href={`/stock/${form.symbol || "AAPL"}`}>Lynch verdict for {form.symbol || "a stock"}</a>{" "}
          before you buy. Needs a non-research mode on the API (<span className="mono">ADVISORY</span> or <span className="mono">DISCRETIONARY</span>); paper execution only.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Symbol</span>
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="AAPL" />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Side</span>
            <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Quantity</span>
            <input value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} inputMode="decimal" />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Limit price ($)</span>
            <input value={form.limitPrice} onChange={(e) => setForm({ ...form, limitPrice: e.target.value })} inputMode="decimal" placeholder="market" />
          </label>
          <button className="btn" onClick={placeOrder}>Submit paper order</button>
        </div>
        {msg && <p className="muted small" style={{ marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  );
}

/** Portfolio vs benchmark, both rebased to 100 at the first daily snapshot. Plain SVG, no chart library. */
function PerformanceChart({ perf, benchmark }: { perf: Performance | null; benchmark: string }) {
  const series = perf?.series ?? [];
  if (series.length < 2)
    return (
      <p className="muted small" style={{ margin: 0 }}>
        History starts {series.length ? `on ${series[0]!.date}` : "today"}. The portfolio is recorded once a day whenever this page or the agent
        reads it; the line appears after the second day.
      </p>
    );
  const W = 560, H = 220, pad = 28;
  const values = series.flatMap((s) => [s.portfolio, s.benchmark ?? s.portfolio]);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / span) * (H - 2 * pad);
  const line = (pick: (s: (typeof series)[number]) => number | null) =>
    series
      .map((s, i) => [i, pick(s)] as const)
      .filter(([, v]) => v !== null)
      .map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v!).toFixed(1)}`)
      .join(" ");
  const last = series.at(-1)!;
  const change = (v: number | null) => (v === null ? "—" : `${v - 100 >= 0 ? "+" : ""}${(v - 100).toFixed(2)}%`);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Portfolio ${change(last.portfolio)}, ${benchmark} ${change(last.benchmark)} since ${series[0]!.date}`}>
        <line x1={pad} x2={W - pad} y1={y(100)} y2={y(100)} stroke="var(--border-strong)" strokeDasharray="4 4" />
        <path d={line((s) => s.benchmark)} fill="none" stroke="var(--border-strong)" strokeWidth={2} />
        <path d={line((s) => s.portfolio)} fill="none" stroke="var(--brand)" strokeWidth={2.5} />
        <text x={pad} y={H - 6} fontSize={11} fill="currentColor" opacity={0.6}>{series[0]!.date}</text>
        <text x={W - pad} y={H - 6} fontSize={11} fill="currentColor" opacity={0.6} textAnchor="end">{last.date}</text>
      </svg>
      <div className="split-legend" style={{ marginTop: 6 }}>
        <span>
          <i style={{ background: "var(--brand)" }} />
          Portfolio <b className="mono">{change(last.portfolio)}</b>
        </span>
        <span>
          <i style={{ background: "var(--border-strong)" }} />
          {benchmark} <b className="mono">{change(last.benchmark)}</b>
        </span>
      </div>
      <p className="faint small" style={{ margin: "6px 0 0" }}>Value change including deposits and withdrawals, if any. Past performance is not a guide to future returns.</p>
    </div>
  );
}

export default protectPage(PortfolioPage);
