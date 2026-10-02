"use client";

import { use, useEffect, useState } from "react";
import { getResearch, isSyntheticSourceId, type ResearchView } from "../../../lib/api";
import { ConvictionGauge, CriteriaList, VerdictBadge, VerdictExplainer } from "../../../components/decision-ui";
import { DemoDataBanner } from "../../../components/demo-data-banner";
import { WatchButton } from "../../../components/watchlist-ui";
import {
  DASH,
  PillarRing,
  ProvenanceChip,
  QualityGauge,
  RangeBar,
  SectionNav,
  TickerSearch,
  Tile,
  ValueBars,
  WatchlistButton,
  bigMoney,
  frac,
  money,
  pct,
  ratio,
  signColor,
  hueFor,
} from "../../../components/research-ui";
import {
  AdvancedChart,
  CompanyProfile,
  FinancialsWidget,
  SymbolNews,
  TechnicalAnalysis,
} from "../../../components/tradingview";

const SECTIONS: Array<[string, string]> = [
  ["summary", "Summary"],
  ["valuation", "Intrinsic value"],
  ["checklist", "Lynch checklist"],
  ["chart", "Chart"],
  ["fundamentals", "Fundamentals"],
  ["financials", "Financials"],
  ["momentum", "Momentum & news"],
  ["audit", "Audit"],
];

/**
 * Stock research page. Layout modelled on research terminals such as ValueSense: header with
 * actions, section nav, quality profile, intrinsic value, chart, financials. The verdict and
 * conviction come from the Lynch engine unchanged; every other number is labelled as
 * descriptive evidence with its source.
 */
export default function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = use(params).symbol.toUpperCase();
  const [data, setData] = useState<ResearchView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    getResearch(symbol)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed"));
  }, [symbol]);

  if (error) {
    return (
      <div className="page-narrow">
        <h1>{symbol}</h1>
        <p style={{ color: "var(--danger)" }}>
          Could not analyse {symbol} ({error}). The ticker may be unknown to the data provider, or the API may be down.
        </p>
        <TickerSearch />
      </div>
    );
  }
  if (!data) return <p className="muted" style={{ marginTop: 24 }}>Analysing {symbol}…</p>;

  const r = data.decision.record;
  const f = data.fundamentals;
  const p = data.price;
  const v = data.valuation;
  const q = data.quality;
  const synthetic = [...new Set(data.provenance.map((x) => x.source).filter(isSyntheticSourceId))];
  const fundamentalsProv = data.provenance.find((x) => x.field === "fundamentals");
  const priceProv = data.provenance.find((x) => x.field === "price");
  const passes = r.criteria.filter((c) => c.result === "pass").length;
  const scored = r.criteria.filter((c) => c.result !== "na").length;

  return (
    <div className="research">
      <section className="card research-header">
        <div className="research-title">
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span className={`ticker-logo ${hueFor(symbol)}`} aria-hidden>
              {symbol.slice(0, 4)}
            </span>
            <div>
              <h1>
                {symbol} <VerdictBadge verdict={r.verdict} large /> <WatchButton symbol={symbol} />
              </h1>
              <div className="company-sub">
                <span>
                  Lynch category <b>{r.lynchCategory?.replace(/_/g, " ") ?? DASH}</b>
                </span>
                <span>
                  Market cap <b className="mono">{bigMoney(f.marketCapUsd)}</b>
                </span>
                <span>
                  P/E <b className="mono">{ratio(f.peRatio, 1)}</b>
                </span>
                {fundamentalsProv?.asOf && (
                  <span>
                    Fundamentals as of <b>{fundamentalsProv.asOf.slice(0, 10)}</b>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="research-price">
            <div className="mono price">{money(p?.price)}</div>
            {p && (
              <>
                <span className={`price-change ${(p.returns["1M"] ?? 0) >= 0 ? "up" : "down"}`}>
                  <span className="mono">{frac(p.returns["1M"], true)}</span> 1 month
                </span>
                <div className="faint small" style={{ marginTop: 4 }}>
                  as of {p.asOf.slice(0, 10)}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="action-row">
          <a className="action-tile hue-sky" href="#chart">
            <span>Explore the price chart</span>
            <span className="go" aria-hidden>
              ↗
            </span>
          </a>
          <WatchlistButton symbol={symbol} />
          <a className="action-tile hue-emerald" href={`/decision/${symbol}`}>
            <span>Decision record & on-chain proof</span>
            <span className="go" aria-hidden>
              →
            </span>
          </a>
        </div>
        <SectionNav sections={SECTIONS} />
      </section>

      <DemoDataBanner sources={synthetic} />

      <section id="summary" className="research-section">
        <h2>{symbol} at a glance</h2>
        <div className="two-col">
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">Quality profile</div>
              <span className="faint small">descriptive, 0-10</span>
            </div>
            <QualityGauge value={q.overall} />
            <div className="pillars">
              <PillarRing value={q.growth} label="Growth" />
              <PillarRing value={q.profitability} label="Profitability" />
              <PillarRing value={q.health} label="Health" />
              <PillarRing value={q.capitalAllocation} label="Capital allocation" />
              <PillarRing value={q.momentum} label="Momentum" />
            </div>
            <details className="explainer">
              <summary>How this profile works</summary>
              <p>
                Descriptive only: it does not change the verdict. Each pillar scores 0-10 from the same fundamentals the engine
                used: growth (EPS and revenue growth, consistency), profitability (ROE, free cash flow), health (debt to equity,
                current ratio, net cash), capital allocation (payout, insider buying, ROE) and momentum (3, 6 and 12-month
                returns). Weights: growth and profitability 25% each, health and capital allocation 20% each, momentum 10%.
                Momentum is deliberately light because a dip buyer looks at quality the market is selling. Missing inputs are
                skipped, never scored as zero.
              </p>
            </details>
          </div>

          <div className="card">
            <div className="card-title">Lynch verdict</div>
            <VerdictExplainer record={r} />
            <ConvictionGauge score={r.convictionScore} />
            <div className="tile-grid">
              <Tile label="Below 52-week high" value={frac(p?.drawdown)} hint={p ? `high ${money(p.high52w)}` : "no price history"} />
              <Tile
                label="Vs intrinsic value"
                value={frac(v.upside, true)}
                color={signColor(v.upside)}
                hint={v.intrinsicValue !== null ? `intrinsic ${money(v.intrinsicValue)}` : "models not applicable"}
              />
              <Tile label="Checklist" value={`${passes}/${scored}`} hint="criteria passed (n/a excluded)" />
              <Tile label="Lynch ratio" value={ratio(v.lynchRatio)} color={v.lynchRatio !== null && v.lynchRatio >= 1.5 ? "var(--success)" : undefined} hint="(growth + yield) / P/E; 2+ is a bargain" />
            </div>
            {p && <RangeBar low={p.low52w} high={p.high52w} position={p.rangePosition} />}
          </div>
        </div>
      </section>

      <section id="valuation" className="research-section">
        <h2>{symbol} intrinsic value</h2>
        <div className="tile-grid four">
          <div className="hue-violet" style={{ display: "contents" }}><Tile label="Intrinsic value" value={money(v.intrinsicValue)} /></div>
          <Tile
            label={v.upside === null ? "Valuation" : v.upside >= 0 ? "Undervalued by" : "Overvalued by"}
            value={frac(v.upside === null ? null : Math.abs(v.upside))}
            color={signColor(v.upside)}
          />
          <div className="hue-emerald" style={{ display: "contents" }}><Tile label="Peter Lynch fair value" value={money(v.lynchFairValue)} /></div>
          <div className="hue-amber" style={{ display: "contents" }}><Tile label="Graham value" value={money(v.grahamValue)} /></div>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <ValueBars
            rows={[
              { label: "Current share price", value: p?.price ?? null, color: "var(--neutral)" },
              { label: "Intrinsic value (mean of models)", value: v.intrinsicValue, color: "var(--primary)" },
              { label: "Peter Lynch fair value", value: v.lynchFairValue, color: "var(--success)" },
              { label: "Graham revised value", value: v.grahamValue, color: "#f59e0b" },
            ]}
          />
          <p className="footnote">
            Peter Lynch fair value = EPS × (growth + dividend yield), growth capped at 25%. Graham = EPS × (8.5 + 2g) × 4.4 / Y, g
            capped at 15%, Y = {v.aaaYieldPct}% assumed AAA corporate yield. EPS is implied from price and P/E ({money(v.eps)}); growth
            is the engine&apos;s EPS growth ({pct(f.epsGrowthPct)}). Neither model applies to loss-making companies. These are
            simplified screens, not price targets.{" "}
            <a href={`/tools/fair-value?symbol=${symbol}`}>Try your own growth and yield assumptions</a>
          </p>
        </div>
      </section>

      <section id="checklist" className="research-section">
        <h2>Why: the Lynch checklist</h2>
        <div className="card">
          <CriteriaList criteria={r.criteria} />
          {r.sellTriggers.length > 0 && (
            <div className="narrative" style={{ marginTop: 20 }}>
              <div className="card-title" style={{ marginBottom: 4 }}>
                What Lynch would watch for in a {r.lynchCategory?.replace(/_/g, " ") ?? "stock like this"}
              </div>
              <p className="muted small" style={{ marginBottom: 8 }}>
                A reading list for the story, not automated sell rules.
              </p>
              <div className="chip-row" style={{ marginBottom: 0 }}>
                {r.sellTriggers.map((t, i) => (
                  <span key={i} className="perf-chip">
                    {t.replace(/>=/g, "≥")}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section id="chart" className="research-section">
        <h2>{symbol} share price</h2>
        <div className="card">
          {p && (
            <div className="chip-row">
              {(["1M", "3M", "6M", "YTD", "1Y"] as const).map((k) => (
                <span key={k} className="perf-chip mono">
                  {k} <b style={{ color: signColor(p.returns[k]) }}>{frac(p.returns[k], true)}</b>
                </span>
              ))}
              {priceProv && <ProvenanceChip source={priceProv.source} asOf={priceProv.asOf} />}
            </div>
          )}
          <AdvancedChart symbol={symbol} />
        </div>
      </section>

      <section id="fundamentals" className="research-section">
        <h2>
          Fundamentals the verdict used {fundamentalsProv && <ProvenanceChip source={fundamentalsProv.source} asOf={fundamentalsProv.asOf} />}
        </h2>
        <div className="metric-groups">
          <MetricGroup
            title="Valuation"
            rows={[
              ["P/E", ratio(f.peRatio, 1)],
              ["5-year average P/E", ratio(f.fiveYearAvgPe, 1)],
              ["Dividend yield", pct(f.dividendYieldPct)],
              ["Payout ratio", f.payoutRatio === null ? DASH : frac(f.payoutRatio)],
            ]}
          />
          <MetricGroup
            title="Growth"
            rows={[
              ["EPS growth", pct(f.epsGrowthPct)],
              ["Revenue growth", pct(f.revenueGrowthPct)],
              ["Inventory growth", pct(f.inventoryGrowthPct)],
              ["EPS growth history", f.epsGrowthHistoryPct.length ? f.epsGrowthHistoryPct.map((x) => `${x.toFixed(0)}%`).join(" · ") : DASH],
            ]}
          />
          <MetricGroup
            title="Profitability & health"
            rows={[
              ["ROE", pct(f.roePct)],
              ["Free cash flow", bigMoney(f.freeCashFlow)],
              ["Debt to equity", f.debtToEquity !== null && f.debtToEquity < 0 ? "negative equity" : ratio(f.debtToEquity)],
              ["Current ratio", ratio(f.currentRatio)],
            ]}
          />
          <MetricGroup
            title="Size & ownership"
            rows={[
              ["Market cap", bigMoney(f.marketCapUsd)],
              ["Sales", bigMoney(f.salesUsd)],
              ["Net cash per share", money(f.netCashPerShare)],
              ["Insiders", f.insiderNetBuying === null ? DASH : f.insiderNetBuying ? "net buying" : "net selling"],
            ]}
          />
        </div>
      </section>

      <section id="financials" className="research-section">
        <h2>{symbol} financials</h2>
        <div className="two-col wide-left">
          <div className="card flush">
            <FinancialsWidget symbol={symbol} />
          </div>
          <div className="card flush">
            <CompanyProfile symbol={symbol} />
          </div>
        </div>
        <p className="footnote">Financial statements and company profile from TradingView, shown for context; the verdict uses the fundamentals above.</p>
      </section>

      <section id="momentum" className="research-section">
        <h2>Momentum & news</h2>
        <div className="two-col">
          <div className="card flush">
            <TechnicalAnalysis symbol={symbol} />
          </div>
          <div className="card flush">
            <SymbolNews symbol={symbol} />
          </div>
        </div>
      </section>

      <section id="audit" className="research-section">
        <h2>Audit</h2>
        <div className="card">
          <p className="kv" title="SHA-256 of the DecisionRecord, anchorable on Algorand">
            <span>🔗 hash</span>
            <b className="mono wrap">{data.decision.hash}</b>
          </p>
          <div className="chip-row" style={{ marginTop: 12 }}>
            <a className="btn" href={`/decision/${symbol}`}>Open decision record</a>
            <a className="btn btn-outline" href="/verify">Verify a record</a>
          </div>
        </div>
      </section>

      <section className="card research-footer">
        <p>Research another stock</p>
        <TickerSearch />
      </section>
    </div>
  );
}

function MetricGroup({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <dl className="metric-list">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{val}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
