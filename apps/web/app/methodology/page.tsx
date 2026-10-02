"use client";

import { useEffect, useState } from "react";

interface Category {
  buy: Record<string, unknown>;
  sell: Record<string, unknown>;
  weights?: Record<string, number>;
  provenance: string;
}
interface Config {
  version: string;
  conventions: { peg_convention: string; peg_note?: string };
  categories: Record<string, Category>;
  global_criteria: Record<string, Record<string, unknown>>;
  scoring: { verdict_bands: { buy_gte?: number; hold_band?: [number, number]; avoid_sell_lt?: number }; buy_excluded_categories?: string[] };
  risk_guardrails: Record<string, unknown>;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

const CATEGORY_BLURB: Record<string, string> = {
  slow_grower: "Large, mature companies growing about as fast as the economy. Bought for a safe, well-covered dividend.",
  stalwart: "Big, dependable companies growing earnings at a steady clip. Bought at a fair price, trimmed after a good run.",
  fast_grower: "Smaller, aggressive companies growing 20%+ a year. Lynch's ten-baggers, if the growth is funded and has room to run.",
  cyclical: "Earnings rise and fall with the economy. Bought when earnings are depressed, sold near the peak.",
  turnaround: "Battered companies that could recover. The question is survival first, upside second.",
  asset_play: "Companies sitting on assets the market has overlooked: cash, property, holdings.",
};

const LABELS: Record<string, string> = {
  peg: "PEG ratio",
  peg_strong: "Strongly underpriced PEG",
  growth_consistency: "Growth consistency",
  growth_quality: "Growth quality",
  debt_to_equity: "Debt to equity",
  roe: "Return on equity",
  pe_vs_5y_avg: "P/E vs own 5-year average",
  value_trap_guard: "Value-trap guard",
  room_to_expand: "Room to expand",
  insider_buying: "Insider buying",
  dividend_yield: "Dividend yield",
  dividend_cover: "Dividend cover",
  fcf_positive: "Free cash flow",
  cycle_position: "Cycle position",
  inventory_trend: "Inventory vs sales",
  balance_sheet_survivability: "Balance-sheet survivability",
  net_cash: "Net cash",
  recovery_evidence: "Recovery evidence",
  asset_value_ratio: "Hidden asset value",
  net_cash_floor: "Net cash floor",
  catalyst_present: "Catalyst",
};

const human = (k: string) => (LABELS[k] ?? k.replace(/_/g, " ")).replace(/^\w/, (c) => c.toUpperCase());

function describe(v: unknown): string {
  if (v === true) return "required";
  if (typeof v === "number") return v >= 1e9 ? `$${v / 1e9}B` : String(v);
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const parts = [o.gte !== undefined && `≥ ${o.gte}`, o.lte !== undefined && `≤ ${o.lte}`].filter(Boolean);
    if (parts.length) return parts.join(" and ");
    return JSON.stringify(v);
  }
  return String(v);
}

function RuleList({ rules }: { rules: Record<string, unknown> }) {
  const entries = Object.entries(rules).filter(([k]) => k !== "note");
  return (
    <dl className="metric-list">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{human(k)}</dt>
          <dd>{describe(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function MethodologyPage() {
  const [data, setData] = useState<{ hash: string; config: Config } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE}/strategy/config`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed — is the API on :3001?"));
  }, []);

  if (error) return <p style={{ color: "var(--danger)", marginTop: 24 }}>{error}</p>;
  if (!data) return <p className="muted" style={{ marginTop: 40 }}>Loading methodology…</p>;
  const c = data.config;
  const bands = c.scoring.verdict_bands;

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Strategy</span>
        <h1>
          How DipBuyer <span className="grad-text">decides</span>
        </h1>
        <p>
          Peter Lynch&apos;s method, written down as a versioned config. Each company is classified into one of Lynch&apos;s six
          categories and scored on that category&apos;s checklist. The config hash is stamped into every decision, so any verdict
          can be reproduced against the exact rules in force.
        </p>
      </div>

      <div className="card stat-band" style={{ marginTop: 16 }}>
        <div>
          <div className="v mono">{c.version}</div>
          <div className="l">Strategy config version</div>
        </div>
        <div>
          <div className="v mono">≥ {bands.buy_gte ?? 70}</div>
          <div className="l">Conviction needed for a buy</div>
        </div>
        <div>
          <div className="v mono">
            {bands.hold_band?.[0] ?? 40}-{bands.hold_band?.[1] ?? 69}
          </div>
          <div className="l">Hold band; below is avoid</div>
        </div>
        <div>
          <div className="v mono" title={data.hash} style={{ fontSize: "1.2rem", paddingTop: 8 }}>
            {data.hash.slice(0, 12)}…
          </div>
          <div className="l">Config hash (SHA-256)</div>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 56 }}>
        <h2>The six Lynch categories</h2>
        <p>Weights are what the engine scores. A failed hard limit (debt to equity above 0.8, outside financials and utilities) rejects a stock outright.</p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(360px, 100%), 1fr))" }}>
        {Object.entries(c.categories).map(([name, cat], idx) => {
          const hue = ["hue-violet", "hue-sky", "hue-emerald", "hue-amber", "hue-rose", "hue-violet"][idx % 6];
          const weights = Object.entries(cat.weights ?? {}).sort((a, b) => b[1] - a[1]);
          const total = weights.reduce((s, [, w]) => s + w, 0) || 1;
          const excluded = c.scoring.buy_excluded_categories?.includes(name);
          return (
            <div className={`card ${hue}`} key={name} style={{ borderTop: "3px solid transparent", backgroundImage: "linear-gradient(var(--bg-elevated), var(--bg-elevated)), var(--hue-grad)", backgroundOrigin: "border-box", backgroundClip: "padding-box, border-box" }}>
              <div className="head">
                <h3 style={{ margin: 0, textTransform: "capitalize" }}>{name.replace(/_/g, " ")}</h3>
                <span className="prov-chip">{cat.provenance === "lynch_book" ? "Lynch's own numbers" : "implementation default"}</span>
              </div>
              <p className="muted small" style={{ margin: "8px 0 16px" }}>
                {CATEGORY_BLURB[name]}
                {excluded && <b style={{ color: "var(--warning)" }}> New buys capped at hold (backtest evidence).</b>}
              </p>
              {weights.length > 0 && (
                <>
                  <div className="tile-label" style={{ marginBottom: 8 }}>Scored checklist</div>
                  <div className="value-bars" style={{ gap: 10, marginBottom: 18 }}>
                    {weights.map(([k, w]) => (
                      <div key={k}>
                        <div className="value-bar-label" style={{ fontSize: "0.84rem", marginBottom: 4 }}>
                          <span>{human(k)}</span>
                          <span className="mono muted">{Math.round((w / total) * 100)}%</span>
                        </div>
                        <div className="value-bar-track" style={{ height: 8 }}>
                          <div style={{ width: `${(w / total) * 100}%`, background: "var(--hue-grad)" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <details className="explainer">
                <summary>Lynch&apos;s buy and sell rules</summary>
                <div className="tile-label" style={{ margin: "12px 0 4px" }}>Buy</div>
                <RuleList rules={cat.buy} />
                <div className="tile-label" style={{ margin: "12px 0 4px" }}>Sell</div>
                <RuleList rules={cat.sell} />
              </details>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        Enforced in code today: the scored weights, verdict bands, the debt-to-equity hard limit, the value-trap cap and the
        cyclical buy cap. The buy and sell rules above are Lynch&apos;s documented targets; not all of them are enforced yet
        (profit-taking after a 30-50% gain, for example, is not). Turnarounds and asset plays cannot be identified from SEC filings
        alone, so the engine does not assign them today.
      </p>

      <div className="section-head" style={{ marginTop: 56 }}>
        <h2>Portfolio guardrails</h2>
        <p>Limits the portfolio engine applies to every order, whatever the verdict.</p>
      </div>
      <div className="tile-grid four">
        {Object.entries(c.risk_guardrails)
          .filter(([k]) => k !== "note")
          .map(([k, v]) => (
            <div className="tile" key={k}>
              <div className="tile-label">{human(k)}</div>
              <div className="tile-value mono">
                {String(v)}
                {k.endsWith("_pct") || k.includes("pct_of") ? "%" : ""}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
