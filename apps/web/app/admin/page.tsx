"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthedFetch } from "../../components/use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface WhoAmI {
  subject: string | null;
  admin: boolean;
  reason: string;
}
interface Overview {
  runtime: { mode: string; execution: string; liveTradingEnabled: boolean; halted: boolean; broker: string; strategyVersion: string };
  schedules: Record<string, string | boolean>;
  data: {
    insiderUpdatedAt: string | null;
    insiderPurchases: number;
    insiderLatestFiling: string | null;
    insiderRefresh: string;
    insiderRefreshRunning: boolean;
    insiderLastRefresh: { at: string; ok: boolean; summary: string } | null;
  };
  investors: {
    total: number;
    onboarded: number;
    unsuitable: number;
    digestOptIns: number;
    recent: Array<{ userId: string; email: string | null; name: string | null; kyc: string | null; kycDemo: boolean | null; suitability: string | null; digest: boolean; createdAt: string }>;
  };
  models: Array<{ id: string; name: string; equity: number; returnPct: number | null; benchmarkReturnPct: number | null; followers: number; lastRebalance: string | null }>;
  agent: { runsThisWeek: number; copyPlansThisWeek: number; ordersPlacedThisWeek: number };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export default function AdminPage() {
  const authedFetch = useAuthedFetch();
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
      const w = await call<WhoAmI>("/admin/whoami");
      setMe(w);
      if (w.admin) setOv(await call<Overview>("/admin/overview"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(label: string, path: string, done: (r: unknown) => string) {
    setBusy(label);
    setMsg(null);
    try {
      const r = await call<unknown>(path, { method: "POST" });
      setMsg(done(r));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!me) return <p className="muted">Checking access…</p>;
  if (!me.admin)
    return (
      <div className="card" style={{ maxWidth: 640, margin: "40px auto" }}>
        <div className="card-title">Admin only</div>
        <p className="muted">You do not have access to this page ({me.reason}).</p>
        {me.subject && (
          <p className="small">
            Your account ID is <code>{me.subject}</code>. If you are the operator, add it to <code>ADMIN_SUBJECTS</code> on the API server.
          </p>
        )}
      </div>
    );

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Admin</span>
        <h1>Operator console</h1>
        <p>Signed in as {me.subject ?? "local admin"} ({me.reason}).</p>
      </div>
      {msg && <div className="card small" style={{ marginBottom: 16 }}>{msg}</div>}

      {ov && (
        <>
          <div className="card stat-band">
            <div>
              <div className="v">{ov.runtime.mode.replace(/_/g, " ").toLowerCase()}</div>
              <div className="l">Mode · {ov.runtime.execution.toLowerCase()} · broker {ov.runtime.broker}</div>
            </div>
            <div>
              <div className="v" style={{ color: ov.runtime.halted ? "var(--danger)" : "var(--success)" }}>{ov.runtime.halted ? "Halted" : "Running"}</div>
              <div className="l">Live trading {ov.runtime.liveTradingEnabled ? "ENABLED" : "off"} · strategy {ov.runtime.strategyVersion}</div>
            </div>
            <div>
              <div className="v mono">{ov.investors.onboarded} / {ov.investors.total}</div>
              <div className="l">Investors onboarded · {ov.investors.unsuitable} unsuitable · {ov.investors.digestOptIns} digest</div>
            </div>
            <div>
              <div className="v mono">{ov.agent.ordersPlacedThisWeek}</div>
              <div className="l">Orders this week · {ov.agent.runsThisWeek} runs · {ov.agent.copyPlansThisWeek} copy plans</div>
            </div>
          </div>

          <div className="two-col" style={{ marginTop: 20 }}>
            <div className="card">
              <div className="card-title">Schedules and data</div>
              <table className="data-table" style={{ minWidth: 0 }}>
                <tbody>
                  {Object.entries(ov.schedules).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="mono">{String(v)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>insider refresh</td>
                    <td className="mono">
                      {ov.data.insiderRefresh}
                      {ov.data.insiderRefreshRunning ? " · running now" : ""}
                      {ov.data.insiderLastRefresh && ` · last ${when(ov.data.insiderLastRefresh.at)} ${ov.data.insiderLastRefresh.ok ? "ok" : "FAILED"}: ${ov.data.insiderLastRefresh.summary}`}
                    </td>
                  </tr>
                  <tr>
                    <td>insider data</td>
                    <td className="mono">
                      {ov.data.insiderPurchases} purchases, latest filing {ov.data.insiderLatestFiling ?? "—"}, file {when(ov.data.insiderUpdatedAt)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-title">Actions</div>
              <div style={{ display: "grid", gap: 10 }}>
                <button className="btn btn-outline" disabled={busy !== null} onClick={() => void act("all", "/admin/models/rebalance-all", () => "Rebalanced every model and created copy plans for followers.")}>
                  {busy === "all" ? "Rebalancing…" : "Rebalance all models + copy plans"}
                </button>
                <button
                  className="btn btn-outline"
                  disabled={busy !== null || ov.data.insiderRefreshRunning}
                  onClick={() => void act("insiders", "/admin/insiders/refresh", () => "Insider refresh started. It runs in the background; reload in a few minutes.")}
                >
                  {ov.data.insiderRefreshRunning ? "Insider refresh running…" : "Refresh insider data now"}
                </button>
                <button
                  className="btn btn-outline"
                  disabled={busy !== null}
                  onClick={() => void act("digest", "/admin/digest/send-all", (r) => `Digest: ${(r as { sent: number }).sent} sent, ${(r as { skipped: number }).skipped} skipped (provider ${String(ov.schedules.emailProvider)}).`)}
                >
                  {busy === "digest" ? "Sending…" : "Send weekly digest now"}
                </button>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 20, padding: 0, overflow: "hidden" }}>
            <div className="table-head">
              <div className="card-title" style={{ margin: 0 }}>Model portfolios</div>
            </div>
            <div className="table-wrap">
              <table className="data-table" style={{ minWidth: 700 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Model</th>
                    <th>Value</th>
                    <th>Since launch</th>
                    <th>SPY</th>
                    <th>Followers</th>
                    <th style={{ textAlign: "left" }}>Last rebalance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ov.models.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td className="mono num">${Math.round(m.equity).toLocaleString("en-US")}</td>
                      <td className="mono num">{pct(m.returnPct)}</td>
                      <td className="mono num">{pct(m.benchmarkReturnPct)}</td>
                      <td className="mono num">{m.followers}</td>
                      <td>{when(m.lastRebalance)}</td>
                      <td className="num">
                        <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => void act(m.id, `/admin/models/${m.id}/rebalance`, () => `${m.name} rebalanced.`)}>
                          {busy === m.id ? "…" : "Rebalance"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginTop: 20, padding: 0, overflow: "hidden" }}>
            <div className="table-head">
              <div className="card-title" style={{ margin: 0 }}>Investors</div>
              <span className="muted small">latest {ov.investors.recent.length} of {ov.investors.total}</span>
            </div>
            <div className="table-wrap">
              <table className="data-table" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Investor</th>
                    <th style={{ textAlign: "left" }}>Identity</th>
                    <th style={{ textAlign: "left" }}>Suitability</th>
                    <th>Digest</th>
                    <th style={{ textAlign: "left" }}>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {ov.investors.recent.map((i) => (
                    <tr key={i.userId}>
                      <td>
                        <b>{i.name ?? "—"}</b>
                        <div className="muted small">{i.email ?? i.userId}</div>
                      </td>
                      <td>{i.kyc ?? "—"}{i.kycDemo ? " (demo)" : ""}</td>
                      <td>{i.suitability ?? "—"}</td>
                      <td className="num">{i.digest ? "yes" : "—"}</td>
                      <td>{when(i.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="faint small" style={{ marginTop: 12 }}>Holds personal data. Operator use only.</p>
        </>
      )}
    </div>
  );
}
