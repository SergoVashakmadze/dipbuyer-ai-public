"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { VerdictBadge } from "../../components/decision-ui";
import { hueFor } from "../../components/research-ui";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Buy {
  insider: string;
  title: string;
  usd: number;
  shares: number;
  price: number;
  tradeDate: string;
  filed: string;
}
interface Company {
  ticker: string;
  company: string;
  purchases: number;
  insiders: number;
  totalUsd: number;
  lastFiled: string;
  topExecutiveBought: boolean;
  largest: Pick<Buy, "insider" | "title" | "usd" | "tradeDate" | "filed">;
  recent: Buy[];
}
interface Payload {
  since: string;
  updatedAt: string | null;
  source: string;
  companies: Company[];
}
interface ScreenerRow {
  symbol: string;
  verdict: string;
  convictionScore: number;
  drawdown: number | null;
}

const usd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`;
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function InsidersPage() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Map<string, ScreenerRow>>(new Map());
  const [execOnly, setExecOnly] = useState(false);
  const [clusterOnly, setClusterOnly] = useState(false);
  // Tiny buys are mostly dividend reinvestment or plan purchases filed under the same code: noise here.
  const [hideSmall, setHideSmall] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`${BASE}/insiders?days=${days}&minUsd=${hideSmall ? 10_000 : 0}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))))
      .then((p: Payload) => {
        setData(p);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? `${e.message} — is the API running on :3001?` : "Request failed"));
  }, [days, hideSmall]);

  // Verdicts come from the research screener (cached server-side); the table never waits for it.
  useEffect(() => {
    fetch(`${BASE}/research/screener`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { rows?: ScreenerRow[] } | null) => s?.rows && setVerdicts(new Map(s.rows.map((row) => [row.symbol, row]))))
      .catch(() => undefined);
  }, []);

  const rows = useMemo(
    () => (data?.companies ?? []).filter((c) => (!execOnly || c.topExecutiveBought) && (!clusterOnly || c.insiders >= 2)),
    [data, execOnly, clusterOnly],
  );
  const total = rows.reduce((t, c) => t + c.totalUsd, 0);

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Research</span>
        <h1>
          Insiders <span className="grad-text">buying their own stock</span>
        </h1>
        <p>
          Directors and officers of S&amp;P 500 companies who bought shares with their own money on the open market, straight from SEC Form 4
          filings. Peter Lynch: insiders sell for many reasons, but they buy for only one.
        </p>
      </div>

      <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div className="segmented" role="radiogroup" aria-label="Window">
          {[30, 90, 180].map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? "active" : undefined} onClick={() => setDays(d)}>
              Last {d} days
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }} className="small">
          <label>
            <input type="checkbox" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} /> Hide buys under $10k
          </label>
          <label>
            <input type="checkbox" checked={execOnly} onChange={(e) => setExecOnly(e.target.checked)} /> CEO, CFO, president or chair bought
          </label>
          <label>
            <input type="checkbox" checked={clusterOnly} onChange={(e) => setClusterOnly(e.target.checked)} /> Two or more insiders (cluster buying)
          </label>
        </div>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {data && (
        <p className="muted small" style={{ margin: "12px 0" }}>
          {rows.length} {rows.length === 1 ? "company" : "companies"} · {usd(total)} bought since {data.since}
          {data.updatedAt && ` · data updated ${new Date(data.updatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
        </p>
      )}

      {data && rows.length === 0 && (
        <div className="card muted">
          {data.companies.length === 0 && !data.updatedAt
            ? "No insider data on this server yet. Run apps/api/scripts/build-insider-recent.mjs to build it."
            : "No purchases match these filters."}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-wrap" style={{ borderTop: 0 }}>
            <table className="data-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Company</th>
                  <th style={{ textAlign: "left" }}>Lynch verdict</th>
                  <th>Bought</th>
                  <th>Buys</th>
                  <th>Insiders</th>
                  <th style={{ textAlign: "left" }}>Largest buyer</th>
                  <th>Latest filing</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const v = verdicts.get(c.ticker);
                  return (
                    <Fragment key={c.ticker}>
                      <tr onClick={() => setOpen(open === c.ticker ? null : c.ticker)} style={{ cursor: "pointer" }}>
                        <td>
                          <div className="company-cell">
                            <span className={`ticker-logo ${hueFor(c.ticker)}`} aria-hidden>{c.ticker.slice(0, 4)}</span>
                            <div>
                              <a className="symbol" href={`/stock/${c.ticker}`} onClick={(e) => e.stopPropagation()}>{c.ticker}</a>
                              <div className="muted small">{titleCase(c.company)}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {v ? (
                            <a href={`/decision/${c.ticker}`} onClick={(e) => e.stopPropagation()} title={`Conviction ${v.convictionScore}/100`}>
                              <VerdictBadge verdict={v.verdict} />
                            </a>
                          ) : (
                            <a className="small" href={`/stock/${c.ticker}`} onClick={(e) => e.stopPropagation()}>Check verdict</a>
                          )}
                        </td>
                        <td className="mono num">{usd(c.totalUsd)}</td>
                        <td className="mono num">{c.purchases}</td>
                        <td className="mono num">{c.insiders}</td>
                        <td>
                          <span className="small">
                            {titleCase(c.largest.insider)}
                            <span className="muted"> · {c.largest.title}</span>
                            {c.topExecutiveBought && <span className="badge buy" style={{ marginLeft: 6 }}>Top executive</span>}
                          </span>
                        </td>
                        <td className="mono num">{c.lastFiled}</td>
                      </tr>
                      {open === c.ticker && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--bg-soft, transparent)" }}>
                            <div className="small">
                              {c.recent.map((b, i) => (
                                <div key={i} style={{ padding: "4px 0" }}>
                                  <b>{titleCase(b.insider)}</b> <span className="muted">({b.title})</span> bought {b.shares.toLocaleString("en-US")} shares at $
                                  {b.price.toFixed(2)} = <b className="mono">{usd(b.usd)}</b> on {b.tradeDate}, filed {b.filed}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <details className="explainer" style={{ marginTop: 24 }}>
        <summary>What our research found about insider buying</summary>
        <p>
          In DipBuyer&apos;s hypothetical 2016-2025 backtest on S&amp;P 500 companies, stocks the Lynch engine rated a buy <i>and</i> where an officer or director had
          bought in the previous 180 days beat their own sector by 6.8% over the next year in 2016-2020 and by 2.1% in 2021-2025. Buy-rated stocks
          without insider buying did not. It is the strongest signal we tested. But used as a portfolio rule on its own it did not beat the S&amp;P 500
          in both halves, so treat it as one piece of evidence, not a reason to buy.
        </p>
        <p>
          Only open-market purchases (Form 4 code P) by directors and officers count. Option exercises, grants, gifts and sales are excluded.
          Data: SEC EDGAR daily Form 4 filings for current S&amp;P 500 members. Not a recommendation. Past performance is not a guide to future returns.
        </p>
      </details>
    </div>
  );
}
