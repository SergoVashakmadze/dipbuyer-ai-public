"use client";

import { useState } from "react";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { protectPage } from "../../components/protect-page";

interface Metrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  winRatePct: number;
  turnoverPct: number;
}
interface BacktestResponse {
  metrics: Metrics;
  equityCurve: Array<{ ts: string; value: number }>;
  decisions: number;
  params: { initialCapital: number; universe: string[] };
  dataSource?: { fundamentals: string; marketData: string; synthetic: boolean };
  reportingLagDays?: number | null;
  exactFilingDates?: boolean;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

function EquityChart({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 800;
  const h = 220;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 8 - ((p - min) / span) * (h - 16)] as const);
  const line = xy.map(([x, y]) => `${x},${y}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <defs>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="url(#eq-fill)" />
      <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function BacktestPage() {
  const [universe, setUniverse] = useState("AAPL, MSFT, RICH");
  const [from, setFrom] = useState("2025-01-01");
  const [to, setTo] = useState("2025-12-31");
  const [res, setRes] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authedFetch = useAuthedFetch();

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch(`${BASE}/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          universe: universe.split(",").map((s) => s.trim()).filter(Boolean),
          from: `${from}T00:00:00Z`,
          to: `${to}T00:00:00Z`,
          rebalance: "monthly",
        }),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      setRes(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed — is the API on :3001?");
    } finally {
      setLoading(false);
    }
  }

  const m = res?.metrics;
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Strategy</span>
        <h1>Backtest studio</h1>
        <p>Run the same engine that makes live decisions over history, point-in-time. Results show which data fed them.</p>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Universe (comma-separated tickers)</span>
            <input value={universe} onChange={(e) => setUniverse(e.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="btn" onClick={run} disabled={loading}>
            {loading ? "Running…" : "Run backtest"}
          </button>
        </div>
        <p className="footnote">
          The ten-year S&amp;P 500 study (point-in-time membership, delisted companies) runs from the command line; its results are on
          the <a href="/">home page</a>.
        </p>
      </div>

      {error && <p style={{ color: "var(--danger)", marginTop: 16 }}>{error}</p>}

      {m && (
        <div style={{ marginTop: 24 }}>
          <div className="tile-grid four" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(170px, 100%), 1fr))" }}>
            <Metric label="Total return" value={`${m.totalReturnPct.toFixed(1)}%`} />
            <Metric label="CAGR" value={`${m.cagrPct.toFixed(1)}%`} />
            <Metric label="Sharpe" value={m.sharpe.toFixed(2)} />
            <Metric label="Sortino" value={m.sortino.toFixed(2)} />
            <Metric label="Max drawdown" value={`${m.maxDrawdownPct.toFixed(1)}%`} />
            <Metric label="Win rate" value={`${m.winRatePct.toFixed(0)}%`} />
          </div>
          <h2>Equity curve</h2>
          <div className="card" style={{ padding: "16px 16px 8px" }}><EquityChart points={res!.equityCurve.map((e) => e.value)} /></div>
          <p className="muted" style={{ fontSize: "0.8rem" }}>{res!.decisions} decisions recorded (each hashable for on-chain audit).</p>

          {/* An equity curve is meaningless without knowing what fed it. A synthetic run looks
              identical to a real one on the chart, so the provenance has to sit next to it. */}
          {res!.dataSource?.synthetic && (
            <div className="demo-banner">
              <strong>Demo data — not a real backtest.</strong> This curve was generated from
              synthetic fixtures ({res!.dataSource.fundamentals}), not market history. It shows the
              engine works; it says nothing about the strategy.
            </div>
          )}
          {res!.dataSource && !res!.dataSource.synthetic && (
            <p className="muted" style={{ fontSize: "0.8rem", marginTop: 12 }}>
              Data: <b>{res!.dataSource.fundamentals}</b> fundamentals ·{" "}
              <b>{res!.dataSource.marketData}</b> prices ·{" "}
              {res!.exactFilingDates ? (
                <span title="Point-in-time cut uses real SEC filing dates">
                  exact filing dates
                </span>
              ) : (
                <span title="Source exposes only fiscal period end, so publication timing is estimated">
                  assumed {res!.reportingLagDays}d publication lag
                </span>
              )}
              . Survivorship bias applies unless the universe is point-in-time.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value mono">{value}</div>
    </div>
  );
}

export default protectPage(BacktestPage);
