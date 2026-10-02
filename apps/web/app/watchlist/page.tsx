"use client";

import { useCallback, useEffect, useState } from "react";
import { VerdictBadge } from "../../components/decision-ui";
import { hueFor } from "../../components/research-ui";
import { useAuthedFetch } from "../../components/use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Rules {
  buy: boolean;
  dipPct: number | null;
  insider: boolean;
}
interface Item {
  symbol: string;
  rules: Rules;
  addedAt: string;
  checkedAt: string | null;
  state: {
    verdict: string | null;
    convictionScore: number | null;
    price: number | null;
    drawdown: number | null;
    lastInsiderFiled: string | null;
    lastInsiderSummary: string | null;
  } | null;
}
interface Alert {
  id: string;
  symbol: string;
  kind: "buy_verdict" | "dip" | "insider_buy";
  message: string;
  at: string;
  read: boolean;
}

const KIND_LABEL: Record<Alert["kind"], [string, string]> = {
  buy_verdict: ["Turned buy", "buy"],
  dip: ["Dip", "hold"],
  insider_buy: ["Insider buying", "buy"],
};

export default function WatchlistPage() {
  const authedFetch = useAuthedFetch();
  const [items, setItems] = useState<Item[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const r = await authedFetch(`${BASE}${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { message?: string; error?: { message?: string } }).message ?? (body as { error?: { message?: string } }).error?.message ?? `API ${r.status}`);
      return body as T;
    },
    [authedFetch],
  );

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([api<{ items: Item[] }>("/watchlist"), api<Alert[]>("/watchlist/alerts")]);
      setItems(w.items);
      setAlerts(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const add = () => {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    void run("add", () => api(`/watchlist/${s}`, { method: "PUT", body: "{}" }).then(() => setSymbol("")));
  };
  const setRules = (s: string, rules: Partial<Rules>) => void run(`rules:${s}`, () => api(`/watchlist/${s}`, { method: "PUT", body: JSON.stringify(rules) }));
  const unread = alerts.filter((a) => !a.read).length;

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Watchlist</span>
        <h1>
          Your <span className="grad-text">watchlist</span>
        </h1>
        <p>
          Stocks you are waiting on. DipBuyer tells you when one turns a Lynch buy, falls far enough below its 52-week high, or when its insiders
          buy shares with their own money.
        </p>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="card" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <label className="field" style={{ margin: 0, minWidth: 200 }}>
          <span>Add a stock</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="KO" onKeyDown={(e) => e.key === "Enter" && add()} />
        </label>
        <button className="btn btn-brand" onClick={add} disabled={busy !== null || !symbol.trim()}>
          {busy === "add" ? "Adding…" : "Add"}
        </button>
        <button className="btn btn-outline" onClick={() => void run("check", () => api("/watchlist/check", { method: "POST" }))} disabled={busy !== null || !items?.length}>
          {busy === "check" ? "Checking…" : "Check now"}
        </button>
        <span className="muted small">New stocks alert on the next change, not on how they look today.</span>
      </div>

      <div style={{ display: "grid", gap: 20, marginTop: 20 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-head">
            <div className="card-title" style={{ margin: 0 }}>Watching</div>
            <span className="muted small">{items?.length ?? 0} stocks</span>
          </div>
          {items && items.length === 0 && <p className="muted" style={{ padding: "0 24px 20px" }}>Nothing yet. Add a ticker above, or press Watch on any stock page.</p>}
          {items && items.length > 0 && (
            <div className="table-wrap">
              <table className="data-table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th style={{ textAlign: "left" }}>Verdict</th>
                    <th>Price</th>
                    <th>Below high</th>
                    <th style={{ textAlign: "left" }}>Alert me when</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.symbol}>
                      <td>
                        <div className="company-cell">
                          <span className={`ticker-logo ${hueFor(i.symbol)}`} aria-hidden>{i.symbol.slice(0, 4)}</span>
                          <div>
                            <a className="symbol" href={`/stock/${i.symbol}`}>{i.symbol}</a>
                            {i.state?.lastInsiderFiled && <div className="muted small">Insider buy {i.state.lastInsiderFiled}</div>}
                          </div>
                        </div>
                      </td>
                      <td>{i.state?.verdict ? <VerdictBadge verdict={i.state.verdict} /> : <span className="muted small">checking…</span>}</td>
                      <td className="mono num">{i.state?.price != null ? `$${i.state.price.toFixed(2)}` : "—"}</td>
                      <td className="mono num">{i.state?.drawdown != null ? `${Math.round(i.state.drawdown * 100)}%` : "—"}</td>
                      <td className="small">
                        <label style={{ display: "block" }}>
                          <input type="checkbox" checked={i.rules.buy} onChange={(e) => setRules(i.symbol, { buy: e.target.checked })} /> it turns buy
                        </label>
                        <label style={{ display: "block" }}>
                          <input type="checkbox" checked={i.rules.dipPct !== null} onChange={(e) => setRules(i.symbol, { dipPct: e.target.checked ? 15 : null })} /> it falls{" "}
                          <select
                            value={i.rules.dipPct ?? 15}
                            disabled={i.rules.dipPct === null}
                            onChange={(e) => setRules(i.symbol, { dipPct: Number(e.target.value) })}
                            aria-label="Dip threshold"
                          >
                            {[5, 10, 15, 20, 25, 30, 40].map((v) => (
                              <option key={v} value={v}>{v}%</option>
                            ))}
                          </select>{" "}
                          below its high
                        </label>
                        <label style={{ display: "block" }}>
                          <input type="checkbox" checked={i.rules.insider} onChange={(e) => setRules(i.symbol, { insider: e.target.checked })} /> an insider buys
                        </label>
                      </td>
                      <td className="num">
                        <button className="btn btn-outline btn-sm" onClick={() => void run(`rm:${i.symbol}`, () => api(`/watchlist/${i.symbol}`, { method: "DELETE" }))} disabled={busy !== null}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title" style={{ margin: 0 }}>Alerts {unread > 0 && <span className="badge buy">{unread} new</span>}</div>
            {unread > 0 && (
              <button className="btn btn-outline btn-sm" onClick={() => void run("read", () => api("/watchlist/alerts/read", { method: "POST" }))}>
                Mark all read
              </button>
            )}
          </div>
          {alerts.length === 0 ? (
            <p className="muted small">No alerts yet. They appear here when something you watch changes.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
              {alerts.slice(0, 50).map((a) => (
                <li key={a.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)", opacity: a.read ? 0.7 : 1 }}>
                  <span className={`badge ${KIND_LABEL[a.kind][1]}`}>{KIND_LABEL[a.kind][0]}</span>{" "}
                  <span className="small">{a.message}</span>
                  <div className="faint small">{new Date(a.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="faint small" style={{ marginTop: 12 }}>Alerts are information, not recommendations to buy or sell.</p>
        </div>
      </div>
    </div>
  );
}
