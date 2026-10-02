"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VerdictBadge } from "../../components/decision-ui";
import { hueFor } from "../../components/research-ui";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { useInvestorId } from "../../components/use-investor-id";
import { protectPage } from "../../components/protect-page";
import { CORE_SATELLITE_HALVES, CORE_SATELLITE_SOURCE, CORE_SATELLITE_SPLITS, splitFor } from "../../lib/core-satellite";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Proposal {
  id: string;
  side: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
  notional: number;
  verdict: string;
  convictionScore: number;
  lynchCategory: string | null;
  sector: string | null;
  reason: string;
  status: "proposed" | "placed" | "skipped" | "failed";
  skipReason?: string;
  limitedBy?: string;
  orderStatus?: string;
  decidedAt?: string;
  decidedBy?: string;
  role?: "core" | "satellite";
}
interface Run {
  id: string;
  trigger: "manual" | "schedule" | "copy";
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  execution: string;
  status: "planned" | "executed" | "blocked" | "failed";
  note?: string;
  universe: string[];
  unavailable: string[];
  decisions: Array<{ symbol: string; verdict: string; convictionScore: number }>;
  sizing: { equity: number; cash: number; intendedPositions: number; equalWeight: number } | null;
  allocation?: { coreSymbol: string; satellitePct: number; totalEquity: number; coreValue: number; satelliteValue: number; satelliteBudget: number; coreTarget: number | null };
  proposals: Proposal[];
}
interface Status {
  mode: string;
  execution: string;
  broker: string;
  halted: boolean;
  canApprove: boolean;
  approveBlockedReason: string | null;
  canAutoExecute: boolean;
  autoExecuteBlockedReason: string | null;
  guardrails: { maxPositions: number; maxPositionPct: number; minCashFloorPct: number; maxSectorPct: number };
  allocation: { coreSymbol: string; satellitePct: number; cashFloorPct: number; coreBandPct: number };
  strategyVersion: string;
  defaultUniverse: string[];
  schedule: { cadence: string; timeUtc: string; autoExecute: boolean; willExecute: boolean; nextRunAt: string | null; lastRun: { at: string; outcome: string } | null };
}

const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 });
const qtyFmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const MODE_LABEL: Record<string, [string, string]> = {
  RESEARCH_ONLY: ["Research only", "The agent screens and proposes. Nothing can be traded."],
  ADVISORY: ["Advisory", "The agent proposes; you approve each trade."],
  DISCRETIONARY: ["Discretionary", "The agent may trade within its mandate; you can still review every run."],
};

const RUN_STATUS: Record<Run["status"], [string, string]> = {
  planned: ["Awaiting review", "hold"],
  executed: ["Executed", "buy"],
  blocked: ["Plan only", "abstain"],
  failed: ["Failed", "sell"],
};

function AgentPage() {
  const authedFetch = useAuthedFetch();
  const investorId = useInvestorId();
  const [status, setStatus] = useState<Status | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [custom, setCustom] = useState(false);
  const [tickers, setTickers] = useState("AAPL, MSFT, KO, NKE, JPM");
  const [busy, setBusy] = useState<"plan" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [satellitePct, setSatellitePct] = useState<number | null>(null);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const r = await authedFetch(`${BASE}${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { message?: string }).message ?? `API ${r.status}`);
      return body as T;
    },
    [authedFetch],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api<Status>("/agent/status"), api<Run[]>("/agent/runs?limit=15")]);
      setStatus(s);
      setSatellitePct((cur) => cur ?? s.allocation?.satellitePct ?? 30);
      setRuns(r);
      // /agent?run=<id> opens that run (links from model copy plans); otherwise the latest.
      const wanted = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("run") : null;
      setRun((cur) => cur ?? r.find((x) => x.id === wanted) ?? r[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? `${e.message} — is the API running on :3001?` : "Request failed");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default selection: every tradeable proposal of the run on screen.
  useEffect(() => {
    setSelected(new Set(run?.proposals.filter((p) => p.status === "proposed").map((p) => p.id) ?? []));
    setConfirming(false);
  }, [run?.id, run?.status]);

  async function plan() {
    setBusy("plan");
    setError(null);
    try {
      const universe = custom ? tickers.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined;
      const r = await api<Run>("/agent/plan", { method: "POST", body: JSON.stringify({ universe, satellitePct: satellitePct ?? undefined }) });
      setRun(r);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Planning failed");
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!run) return;
    setBusy("approve");
    setError(null);
    try {
      const r = await api<Run>(`/agent/runs/${run.id}/approve`, { method: "POST", body: JSON.stringify({ proposalIds: [...selected], userId: investorId }) });
      setRun(r);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  const proposals = run?.proposals ?? [];
  const tradeable = proposals.filter((p) => p.status === "proposed");
  const chosen = tradeable.filter((p) => selected.has(p.id));
  const buyTotal = chosen.filter((p) => p.side === "buy").reduce((t, p) => t + p.notional, 0);
  const sellTotal = chosen.filter((p) => p.side === "sell").reduce((t, p) => t + p.notional, 0);
  const step = !run ? 1 : run.status === "executed" ? 4 : tradeable.length ? 3 : 2;
  const universeSize = custom ? tickers.split(/[,\s]+/).filter(Boolean).length : status?.defaultUniverse.length ?? 0;

  // Sells, then pick buys by conviction, then the index core: the order they are placed in.
  const sorted = useMemo(() => {
    const rank = (p: Proposal) => (p.side === "sell" ? 0 : p.role === "core" ? 2 : 1);
    return [...proposals].sort((a, b) => rank(a) - rank(b) || b.convictionScore - a.convictionScore);
  }, [proposals]);
  const picksOnly = proposals.filter((p) => p.role !== "core");
  const coreSymbol = status?.allocation?.coreSymbol ?? "SPY";
  const split = satellitePct === null ? undefined : splitFor(satellitePct);
  const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

  const [modeName, modeHelp] = MODE_LABEL[status?.mode ?? "RESEARCH_ONLY"] ?? [status?.mode ?? "", ""];

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Agent</span>
        <h1>
          Investing agent <span className="grad-text">demonstration</span>
        </h1>
        <p>
          A technology demonstration of how an agent could propose trades for approval. The modelled portfolio sits in an index core
          ({coreSymbol}) with a satellite of Lynch picks on top. The agent screens the market with the Lynch engine, proposes buys and sells
          for the satellite and keeps the rest in the core. It is not offered for trading until the required licences, penetration testing
          and security audits are complete.
        </p>
      </div>

      {error && (
        <div className="demo-banner" role="alert" style={{ borderColor: "var(--danger)", background: "var(--danger-soft)" }}>
          <strong style={{ color: "var(--danger)" }}>Something went wrong.</strong> {error}
        </div>
      )}

      {status && (
        <div className="card stat-band agent-status" style={{ marginTop: 16 }}>
          <div className="hue-violet">
            <div className="l">Mode</div>
            <div className="v">{modeName}</div>
            <div className="l">{modeHelp}</div>
          </div>
          <div className="hue-sky">
            <div className="l">Execution</div>
            <div className="v">{status.execution === "LIVE" ? "Live money" : "Paper trading"}</div>
            <div className="l">
              Broker: {status.broker}
              {status.halted && <b style={{ color: "var(--danger)" }}> · halted</b>}
            </div>
          </div>
          <div className="hue-emerald">
            <div className="l">Approvals</div>
            <div className="v" style={{ color: status.canApprove ? "var(--success)" : "var(--warning)" }}>{status.canApprove ? "Enabled" : "Not available"}</div>
            <div className="l">{status.canApprove ? `Approving as ${investorId}` : status.approveBlockedReason}</div>
          </div>
          <div className="hue-amber">
            <div className="l">Schedule</div>
            <div className="v" style={{ textTransform: "capitalize" }}>{status.schedule.cadence === "off" ? "Off" : status.schedule.cadence}</div>
            <div className="l">
              {status.schedule.cadence === "off"
                ? "Runs only when you start it"
                : `Next ${status.schedule.nextRunAt ? when(status.schedule.nextRunAt) : "—"} · ${status.schedule.willExecute ? "trades automatically" : "plan only, awaits approval"}`}
            </div>
          </div>
        </div>
      )}

      <ol className="stepper" aria-label="Agent workflow">
        {["Screen the universe", "Plan trades", "Review and approve", "Execute"].map((label, i) => (
          <li key={label} className={i + 1 < step ? "done" : i + 1 === step ? "current" : undefined}>
            <span className="dot">{i + 1 < step ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <div className="card agent-run">
        <div>
          <div className="card-title" style={{ marginBottom: 4 }}>Run the agent</div>
          <p className="muted small" style={{ margin: 0 }}>
            Screens {universeSize} {universeSize === 1 ? "company" : "companies"} plus anything you hold. Planning never places an order.
          </p>
        </div>
        <div className="segmented" role="tablist" aria-label="Universe">
          <button type="button" role="tab" aria-selected={!custom} className={!custom ? "active" : undefined} onClick={() => setCustom(false)}>
            Research universe{status ? ` (${status.defaultUniverse.length})` : ""}
          </button>
          <button type="button" role="tab" aria-selected={custom} className={custom ? "active" : undefined} onClick={() => setCustom(true)}>
            Custom tickers
          </button>
        </div>
        {custom && <input className="input" style={{ margin: 0 }} value={tickers} onChange={(e) => setTickers(e.target.value.toUpperCase())} aria-label="Tickers to screen" />}
        <div>
          <div className="small" style={{ marginBottom: 6 }}>
            <b>Satellite share</b> <span className="muted">· Lynch picks; the rest stays in {coreSymbol}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Satellite share of the portfolio">
            {CORE_SATELLITE_SPLITS.map((s) => (
              <button
                key={s.satellitePct}
                type="button"
                role="radio"
                aria-checked={satellitePct === s.satellitePct}
                className={satellitePct === s.satellitePct ? "active" : undefined}
                onClick={() => setSatellitePct(s.satellitePct)}
              >
                {s.satellitePct}%
              </button>
            ))}
          </div>
          {split && (
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              {split.satellitePct === 0
                ? `Index only: every dollar above the cash floor in ${coreSymbol}.`
                : `${CORE_SATELLITE_SOURCE}: ${split.cagr.toFixed(2)}% a year, ${signed(split.vsSpy)} pts vs ${coreSymbol} (${CORE_SATELLITE_HALVES[0]} ${signed(split.vsSpyFirstHalf)}, ${CORE_SATELLITE_HALVES[1]} ${signed(split.vsSpySecondHalf)}), worst fall ${split.maxDrawdown}%, tracking error ${split.trackingError}%.`}{" "}
              <span className="faint">Past performance is not a guide to future returns.</span>
            </p>
          )}
        </div>
        <button className="btn btn-brand" onClick={plan} disabled={busy !== null}>
          {busy === "plan" ? "Screening…" : "Screen & plan"}
        </button>
        {busy === "plan" && <p className="faint small" style={{ margin: 0 }}>Analysing every company with the Lynch engine. On a cold cache this takes up to a minute.</p>}
      </div>

      {run && (
        <section style={{ marginTop: 28 }}>
          <div className="agent-run-head">
            <div>
              <h2 style={{ margin: 0 }}>
                {run.trigger === "schedule" ? "Scheduled run" : run.trigger === "copy" ? "Copy plan" : "Run"} · {when(run.startedAt)}
              </h2>
              <p className="muted small" style={{ margin: "4px 0 0" }}>
                {run.decisions.length} screened
                {run.unavailable.length > 0 && ` · no data for ${run.unavailable.join(", ")}`} · mode {run.mode.replace(/_/g, " ").toLowerCase()} ·{" "}
                {run.execution.toLowerCase()}
              </p>
            </div>
            <span className={`badge lg ${RUN_STATUS[run.status][1]}`}>{RUN_STATUS[run.status][0]}</span>
          </div>
          {run.note && <p className="muted" style={{ marginTop: 8 }}>{run.note}</p>}

          {run.sizing && (
            <div className="tile-grid four" style={{ marginTop: 16 }}>
              <div className="hue-emerald" style={{ display: "contents" }}>
                <div className="tile">
                  <div className="tile-label">Buys proposed</div>
                  <div className="tile-value mono">{picksOnly.filter((p) => p.side === "buy" && p.status !== "skipped").length}</div>
                  <div className="tile-hint">{usd(picksOnly.filter((p) => p.side === "buy" && p.status !== "skipped").reduce((t, p) => t + p.notional, 0))} in picks</div>
                </div>
              </div>
              <div className="hue-rose" style={{ display: "contents" }}>
                <div className="tile">
                  <div className="tile-label">Sells proposed</div>
                  <div className="tile-value mono">{picksOnly.filter((p) => p.side === "sell").length}</div>
                  <div className="tile-hint">{usd(picksOnly.filter((p) => p.side === "sell").reduce((t, p) => t + p.notional, 0))} of picks</div>
                </div>
              </div>
              <div className="hue-sky" style={{ display: "contents" }}>
                <div className="tile">
                  <div className="tile-label">Portfolio value</div>
                  <div className="tile-value mono">{usd(run.allocation?.totalEquity ?? run.sizing.equity)}</div>
                  <div className="tile-hint">cash {usd(run.sizing.cash)}</div>
                </div>
              </div>
              <div className="hue-violet" style={{ display: "contents" }}>
                {run.allocation ? (
                  <div className="tile">
                    <div className="tile-label">Core / satellite</div>
                    <div className="tile-value mono">
                      {100 - run.allocation.satellitePct} / {run.allocation.satellitePct}
                    </div>
                    <div className="tile-hint">
                      {run.allocation.coreSymbol} {usd(run.allocation.coreValue)}
                      {run.allocation.coreTarget !== null && ` → ${usd(run.allocation.coreTarget)}`} · picks {usd(run.allocation.satelliteValue)} of{" "}
                      {usd(run.allocation.satelliteBudget)}
                    </div>
                  </div>
                ) : (
                  <div className="tile">
                    <div className="tile-label">Equal-weight target</div>
                    <div className="tile-value mono">{usd(run.sizing.equalWeight)}</div>
                    <div className="tile-hint">across {run.sizing.intendedPositions} positions, max {status?.guardrails.maxPositionPct ?? 10}% each</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {proposals.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
              <div className="table-wrap" style={{ borderTop: 0 }}>
                <table className="data-table" style={{ minWidth: 980 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all tradeable proposals"
                          checked={tradeable.length > 0 && chosen.length === tradeable.length}
                          disabled={tradeable.length === 0}
                          onChange={(e) => setSelected(new Set(e.target.checked ? tradeable.map((p) => p.id) : []))}
                        />
                      </th>
                      <th style={{ textAlign: "left" }}>Trade</th>
                      <th style={{ textAlign: "left" }}>Verdict</th>
                      <th>Conviction</th>
                      <th>Quantity</th>
                      <th>Price</th>
                      <th>Amount</th>
                      <th style={{ textAlign: "left" }}>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p) => (
                      <tr key={p.id} className={p.status === "skipped" || p.status === "failed" ? "row-muted" : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.side} ${p.symbol}`}
                            disabled={p.status !== "proposed"}
                            checked={selected.has(p.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(p.id);
                              else next.delete(p.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                        <td>
                          <div className="company-cell">
                            <span className={`ticker-logo ${hueFor(p.symbol)}`} aria-hidden>
                              {p.symbol.slice(0, 4)}
                            </span>
                            <div>
                              <span className={`side-pill ${p.side}`}>{p.side === "buy" ? "Buy" : "Sell"}</span>{" "}
                              {p.role === "core" ? (
                                <span className="symbol">{p.symbol}</span>
                              ) : (
                                <a className="symbol" href={`/stock/${p.symbol}`}>
                                  {p.symbol}
                                </a>
                              )}
                              <div className="muted small" style={{ textTransform: p.role === "core" ? undefined : "capitalize" }}>
                                {p.role === "core" ? "Index core" : [p.lynchCategory?.replace(/_/g, " "), p.sector].filter(Boolean).join(" · ") || "—"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {p.role === "core" ? (
                            <span className="badge hold">Core</span>
                          ) : p.verdict === "copy" ? (
                            <span className="badge hold">Copy</span>
                          ) : (
                            <a href={`/decision/${p.symbol}`} title="Open the decision record">
                              <VerdictBadge verdict={p.verdict} />
                            </a>
                          )}
                        </td>
                        <td className="mono num">{p.role === "core" || p.verdict === "copy" ? "—" : p.convictionScore}</td>
                        <td className="mono num">{p.qty > 0 ? qtyFmt(p.qty) : "—"}</td>
                        <td className="mono num">{usd(p.price)}</td>
                        <td className="mono num">{p.notional > 0 ? usd(p.notional) : "—"}</td>
                        <td style={{ maxWidth: 300 }}>
                          <ProposalStatus p={p} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tradeable.length > 0 && (
            <div className="approve-bar">
              <div>
                <b>{chosen.length} of {tradeable.length} selected</b>
                <span className="muted small">
                  {" "}· buys {usd(buyTotal)} · sells {usd(sellTotal)}
                </span>
                {!status?.canApprove && <div className="small" style={{ color: "var(--warning)" }}>Approval not available: {status?.approveBlockedReason}</div>}
              </div>
              {!confirming ? (
                <button className="btn btn-brand" disabled={!status?.canApprove || chosen.length === 0 || busy !== null} onClick={() => setConfirming(true)}>
                  Review {chosen.length} {chosen.length === 1 ? "order" : "orders"}
                </button>
              ) : (
                <div className="confirm">
                  <span className="small">
                    {/* Only a LIVE runtime says "place"; everything else is a simulation and says so. */}
                    {status?.execution === "LIVE" ? "Place" : "Simulate"} {chosen.length} {status?.execution === "LIVE" ? "LIVE " : ""}
                    {chosen.length === 1 ? "order" : "orders"}? Sells go first, then picks; every buy is
                    re-checked against today&apos;s limits, and the {coreSymbol} core buy takes whatever cash is left above the floor.
                  </span>
                  <button className="btn btn-outline btn-sm" onClick={() => setConfirming(false)} disabled={busy !== null}>
                    Cancel
                  </button>
                  <button className="btn btn-sm" onClick={approve} disabled={busy !== null}>
                    {status?.execution === "LIVE" ? (busy === "approve" ? "Placing…" : "Confirm and place") : busy === "approve" ? "Simulating…" : "Confirm and simulate"}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="section-head" style={{ marginTop: 56, textAlign: "left", maxWidth: "none" }}>
          <h2 style={{ fontSize: "1.45rem" }}>Run history</h2>
          <p>Every run is kept with its decisions, proposals, who approved what, and what the broker did.</p>
        </div>
        {runs.length === 0 ? (
          <div className="card muted">No runs yet. Screen & plan to start.</div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="data-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Started</th>
                  <th style={{ textAlign: "left" }}>Trigger</th>
                  <th style={{ textAlign: "left" }}>Status</th>
                  <th>Screened</th>
                  <th>Proposed</th>
                  <th>Placed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={run?.id === r.id ? "row-active" : undefined}>
                    <td>{when(r.startedAt)}</td>
                    <td>{r.trigger === "schedule" ? "Scheduled" : r.trigger === "copy" ? "Copy of a model" : "Manual"}</td>
                    <td>
                      <span className={`badge ${RUN_STATUS[r.status][1]}`}>{RUN_STATUS[r.status][0]}</span>
                    </td>
                    <td className="mono num">{r.decisions.length}</td>
                    <td className="mono num">{r.proposals.filter((p) => p.status !== "skipped").length}</td>
                    <td className="mono num">{r.proposals.filter((p) => p.status === "placed").length}</td>
                    <td className="num">
                      <button className="btn btn-outline btn-sm" onClick={() => setRun(r)} disabled={run?.id === r.id}>
                        {run?.id === r.id ? "Showing" : "Open"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {status && (
        <details className="explainer" style={{ marginTop: 24 }}>
          <summary>How the agent sizes trades and what it is allowed to do</summary>
          <p>
            <b>Core and satellite.</b> In the 2016-2025 backtest the Lynch picks did not beat {coreSymbol} after adjusting for risk, so the portfolio
            keeps an index core and runs the picks in a satellite (default {status.allocation?.satellitePct ?? 30}% of the portfolio). Everything
            the satellite does not use, apart from the {status.allocation?.cashFloorPct ?? 2}% cash floor, sits in {coreSymbol}, which is also what
            the backtest does with its spare cash. The core is only traded when it is more than {status.allocation?.coreBandPct ?? 1}% of the
            portfolio off target. Picks that grow past the satellite share are not trimmed.
          </p>
          <p>
            Inside the satellite, sizing matches the backtested strategy (config {status.strategyVersion}): equal weight across up to{" "}
            {status.guardrails.maxPositions} positions, at most {status.guardrails.maxPositionPct}% of the satellite per company and{" "}
            {status.guardrails.maxSectorPct}% per sector. Buys go to the highest-conviction names first. Held names that the engine now rates sell or
            avoid are proposed for sale.
          </p>
          <p>
            Modes are set on the server, not here. Research only never trades. Advisory lets a verified investor (identity check and suitability
            assessment on the Onboarding page) approve proposals. Discretionary also lets the agent execute its own runs, and a schedule
            (AGENT_SCHEDULE) can run it daily, weekly or monthly; scheduled runs only plan unless AGENT_SCHEDULE_AUTO_EXECUTE is on. RUNTIME_HALT stops
            all trading immediately.
          </p>
        </details>
      )}
    </div>
  );
}

function ProposalStatus({ p }: { p: Proposal }) {
  if (p.status === "placed")
    return (
      <span className="small">
        <b style={{ color: "var(--success)" }}>Order {p.orderStatus}</b>
        <span className="faint"> · {p.decidedBy?.replace(/^user:/, "approved by ").replace("agent:autonomous", "executed by the agent")}</span>
      </span>
    );
  if (p.status === "skipped" || p.status === "failed")
    return (
      <span className="small">
        <b style={{ color: p.status === "failed" ? "var(--danger)" : "var(--warning)" }}>{p.status === "failed" ? "Failed" : "Not traded"}:</b>{" "}
        <span className="muted">{p.skipReason}</span>
      </span>
    );
  return (
    <span className="small muted">
      {p.reason}
      {p.limitedBy && <span className="faint"> · sized down by the {p.limitedBy}</span>}
    </span>
  );
}

export default protectPage(AgentPage);
