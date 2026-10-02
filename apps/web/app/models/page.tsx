"use client";

import { useCallback, useEffect, useState } from "react";
import { hueFor } from "../../components/research-ui";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { CORE_SATELLITE_HALVES, CORE_SATELLITE_SOURCE, splitFor } from "../../lib/core-satellite";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Model {
  id: string;
  name: string;
  description: string;
  satellitePct: number;
  inception: string | null;
  equity: number;
  cash: number;
  returnPct: number | null;
  benchmarkReturnPct: number | null;
  holdings: Array<{ symbol: string; weight: number; value: number; role: "core" | "satellite" }>;
  lastRebalance: string | null;
  trades: Array<{ at: string | null; side: string; symbol: string; qty: number; price: number }>;
  series: Array<{ date: string; portfolio: number; benchmark: number | null }>;
  followers: number;
  following: boolean;
}

const pct = (v: number | null, digits = 2) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
/** A gap between two returns, in percentage points. */
const pts = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} pts`;
const tone = (v: number | null) => (v === null ? undefined : v > 0 ? "var(--success)" : v < 0 ? "var(--danger)" : undefined);

export default function ModelsPage() {
  const authedFetch = useAuthedFetch();
  const [models, setModels] = useState<Model[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; href?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const r = await authedFetch(`${BASE}${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { message?: string }).message ?? (body as { error?: { message?: string } }).error?.message ?? `API ${r.status}`);
      return body as T;
    },
    [authedFetch],
  );

  const load = useCallback(async () => {
    try {
      setModels(await call<Model[]>("/models"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, label: string, fn: () => Promise<void>) {
    setBusy(`${label}:${id}`);
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg({ id, text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Model portfolios</span>
        <h1>
          Follow a <span className="grad-text">model portfolio</span>
        </h1>
        <p>
          A demonstration: each model is the DipBuyer agent running on its own simulated paper book at a fixed Lynch share, with its
          simulated record since launch. It shows how following a model could work: after each rebalance, a plan that would copy it into an
          account, sized to that account, proposed for approval. Stocks picked by hand would never be touched. Not offered for investment or
          trading until the required licences, penetration testing and security audits are complete.
        </p>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <div style={{ display: "grid", gap: 20 }}>
        {models?.map((m) => {
          const bt = splitFor(m.satellitePct);
          const top = m.holdings.slice(0, 8);
          return (
            <div key={m.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ maxWidth: 620 }}>
                  <h2 style={{ margin: 0 }}>
                    {m.name} <span className="badge hold">{m.satellitePct}% Lynch picks</span>
                  </h2>
                  <p className="muted" style={{ margin: "6px 0 0" }}>{m.description}</p>
                  <p className="faint small" style={{ margin: "4px 0 0" }}>
                    {m.followers} follower{m.followers === 1 ? "" : "s"}
                    {m.lastRebalance && ` · last rebalanced ${new Date(m.lastRebalance).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "start", flexWrap: "wrap" }}>
                  <button
                    className={`btn ${m.following ? "btn-outline" : "btn-brand"}`}
                    disabled={busy !== null}
                    onClick={() => void act(m.id, "follow", () => call(`/models/${m.id}/follow`, { method: m.following ? "DELETE" : "POST" }).then(() => undefined))}
                  >
                    {m.following ? "Following ✓" : "Follow"}
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={busy !== null || !m.holdings.length}
                    onClick={() =>
                      void act(m.id, "copy", async () => {
                        const run = await call<{ id: string; proposals: unknown[]; note?: string }>(`/models/${m.id}/copy`, { method: "POST" });
                        setMsg({ id: m.id, text: run.note ?? "Copy plan ready.", href: run.proposals.length ? `/agent?run=${run.id}` : undefined });
                      })
                    }
                  >
                    {busy === `copy:${m.id}` ? "Planning…" : "Simulate a copy plan"}
                  </button>
                </div>
              </div>
              {msg?.id === m.id && (
                <p className="small" style={{ margin: "10px 0 0" }}>
                  {msg.text} {msg.href && <a href={msg.href}>Review the proposed trades →</a>}
                </p>
              )}

              <div className="tile-grid four" style={{ marginTop: 16 }}>
                <div className="tile">
                  <div className="tile-label">Live since {m.inception ?? "first rebalance"}</div>
                  <div className="tile-value mono" style={{ color: tone(m.returnPct) }}>{pct(m.returnPct)}</div>
                  <div className="tile-hint">S&amp;P 500 (SPY) {pct(m.benchmarkReturnPct)}</div>
                </div>
                <div className="tile">
                  <div className="tile-label">Model value</div>
                  <div className="tile-value mono">${Math.round(m.equity).toLocaleString("en-US")}</div>
                  <div className="tile-hint">from $100,000 paper</div>
                </div>
                <div className="tile">
                  <div className="tile-label">Backtest 2016-2025</div>
                  <div className="tile-value mono">{bt ? `${bt.cagr.toFixed(2)}%` : "—"}</div>
                  <div className="tile-hint">{bt ? `a year, ${pts(bt.vsSpy)} vs SPY` : ""}</div>
                </div>
                <div className="tile">
                  <div className="tile-label">Backtest worst fall</div>
                  <div className="tile-value mono">{bt ? `${bt.maxDrawdown}%` : "—"}</div>
                  <div className="tile-hint">{bt ? `${CORE_SATELLITE_HALVES[0]} ${pts(bt.vsSpyFirstHalf)}, ${CORE_SATELLITE_HALVES[1]} ${pts(bt.vsSpySecondHalf)} vs SPY` : ""}</div>
                </div>
              </div>

              {top.length > 0 ? (
                <div style={{ marginTop: 16 }}>
                  <div className="split-bar" role="img" aria-label="Model weights">
                    {top.map((h) => (
                      <span key={h.symbol} className={h.role === "core" ? "core" : "agent"} style={{ width: `${h.weight * 100}%`, borderRight: "1px solid var(--bg-elevated, #fff)" }} title={`${h.symbol} ${(h.weight * 100).toFixed(1)}%`} />
                    ))}
                  </div>
                  <div className="split-legend">
                    {top.map((h) => (
                      <span key={h.symbol}>
                        <span className={`ticker-logo ${hueFor(h.symbol)}`} style={{ width: 22, height: 22, fontSize: "0.6rem", marginRight: 6, display: "inline-grid", verticalAlign: "middle" }} aria-hidden>
                          {h.symbol.slice(0, 4)}
                        </span>
                        {h.role === "core" ? h.symbol : <a href={`/stock/${h.symbol}`}>{h.symbol}</a>} <b className="mono">{(h.weight * 100).toFixed(1)}%</b>
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="muted small" style={{ marginTop: 16 }}>Not launched yet: the model starts at its first rebalance.</p>
              )}
            </div>
          );
        })}
      </div>

      <p className="footnote" style={{ marginTop: 20 }}>
        Model portfolios are simulated paper books, not client money. Live figures start at each model&apos;s launch and are short. The backtest figures are
        hypothetical ({CORE_SATELLITE_SOURCE}). Following a model gives you a plan to review, not an automatic trade. Past performance is not a guide to
        future returns. Capital at risk.
      </p>
    </div>
  );
}
