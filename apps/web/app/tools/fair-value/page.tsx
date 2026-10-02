"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_AAA_YIELD_PCT,
  GRAHAM_GROWTH_CAP_PCT,
  LYNCH_GROWTH_CAP_PCT,
  grahamValue,
  lynchFairValue,
  lynchRatio,
} from "@dipbuyer/strategy/valuation";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Inputs {
  eps: string;
  growth: string;
  yield: string;
  price: string;
  aaa: string;
}

/** Lynch's own scale for (growth + yield) / P/E, from One Up on Wall Street. */
function ratioLabel(r: number): [string, string] {
  if (r >= 2) return ["What Lynch looked for", "var(--success)"];
  if (r >= 1.5) return ["Okay", "var(--success)"];
  if (r >= 1) return ["Fairly priced at best", "var(--warning)"];
  return ["Poor", "var(--danger)"];
}

const num = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const money = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const pctOf = (fair: number | null, price: number | null) =>
  fair === null || price === null || price <= 0 ? null : ((fair - price) / price) * 100;

function Calculator() {
  const params = useSearchParams();
  const [symbol, setSymbol] = useState((params.get("symbol") ?? "").toUpperCase());
  const [inputs, setInputs] = useState<Inputs>({ eps: "5", growth: "12", yield: "2", price: "100", aaa: String(DEFAULT_AAA_YIELD_PCT) });
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prefill(sym: string) {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/research/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 404 ? `No fundamentals for ${sym}` : `API ${r.status}`);
      const d = (await r.json()) as {
        fundamentals: { epsGrowthPct: number | null; dividendYieldPct: number | null };
        price: { price: number } | null;
        valuation: { eps: number | null; aaaYieldPct: number };
      };
      const f = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "" : String(Number(v.toFixed(digits))));
      setInputs({
        eps: f(d.valuation.eps),
        growth: f(d.fundamentals.epsGrowthPct, 1),
        yield: f(d.fundamentals.dividendYieldPct ?? 0, 2),
        price: f(d.price?.price ?? null),
        aaa: f(d.valuation.aaaYieldPct, 2),
      });
      setLoaded(sym);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the stock");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const s = (params.get("symbol") ?? "").toUpperCase();
    if (s) void prefill(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eps = num(inputs.eps), growth = num(inputs.growth), yld = num(inputs.yield), price = num(inputs.price), aaa = num(inputs.aaa);
  const out = useMemo(() => {
    const lynch = lynchFairValue(eps, growth, yld);
    const graham = grahamValue(eps, growth, aaa ?? DEFAULT_AAA_YIELD_PCT);
    const pe = eps !== null && eps > 0 && price !== null && price > 0 ? price / eps : null;
    const ratio = pe === null ? null : lynchRatio({ peRatio: pe, epsGrowthPct: growth, dividendYieldPct: yld });
    const models = [lynch, graham].filter((v): v is number => v !== null);
    const blended = models.length ? models.reduce((a, b) => a + b, 0) / models.length : null;
    return { lynch, graham, pe, ratio, blended };
  }, [eps, growth, yld, price, aaa]);

  const field = (key: keyof Inputs, label: string, hint: string) => (
    <label className="field" style={{ margin: 0 }}>
      <span>{label}</span>
      <input value={inputs[key]} onChange={(e) => setInputs({ ...inputs, [key]: e.target.value })} inputMode="decimal" />
      <small className="faint">{hint}</small>
    </label>
  );

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Tools</span>
        <h1>
          Lynch <span className="grad-text">fair value</span> calculator
        </h1>
        <p>
          Peter Lynch&apos;s rule of thumb: a fairly priced company&apos;s P/E equals its growth rate plus its dividend yield. Load a stock or type your
          own numbers, and see what price that implies, next to Benjamin Graham&apos;s formula.
        </p>
      </div>

      <div className="card" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <label className="field" style={{ margin: 0, minWidth: 180 }}>
          <span>Load a stock</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="KO" onKeyDown={(e) => e.key === "Enter" && void prefill(symbol)} />
        </label>
        <button className="btn" onClick={() => void prefill(symbol)} disabled={loading || !symbol}>
          {loading ? "Loading…" : "Fill in its numbers"}
        </button>
        {loaded && (
          <span className="muted small">
            Filled from <a href={`/stock/${loaded}`}>{loaded}</a>: trailing EPS, multi-year EPS growth, dividend yield, last price. Edit any of them.
          </span>
        )}
        {error && <span className="small" style={{ color: "var(--danger)" }}>{error}</span>}
      </div>

      <div className="two-col" style={{ marginTop: 16 }}>
        <div className="card" style={{ display: "grid", gap: 14 }}>
          {field("eps", "Earnings per share ($)", "Trailing twelve months, diluted")}
          {field("growth", "EPS growth (% a year)", `Lynch capped this at ${LYNCH_GROWTH_CAP_PCT}%, Graham at ${GRAHAM_GROWTH_CAP_PCT}%`)}
          {field("yield", "Dividend yield (%)", "0 if it pays none")}
          {field("price", "Share price ($)", "To compare against")}
          {field("aaa", "AAA corporate bond yield (%)", "Graham's formula only")}
        </div>

        <div className="card">
          <div className="tile-grid" style={{ gridTemplateColumns: "1fr 1fr", display: "grid", gap: 12 }}>
            <div className="tile">
              <div className="tile-label">Lynch fair value</div>
              <div className="tile-value mono">{money(out.lynch)}</div>
              <div className="tile-hint">
                {out.lynch === null ? "Needs positive EPS and growth" : `${pctOf(out.lynch, price)?.toFixed(1) ?? "—"}% vs price`}
              </div>
            </div>
            <div className="tile">
              <div className="tile-label">Graham value</div>
              <div className="tile-value mono">{money(out.graham)}</div>
              <div className="tile-hint">{out.graham === null ? "Needs positive EPS" : `${pctOf(out.graham, price)?.toFixed(1) ?? "—"}% vs price`}</div>
            </div>
            <div className="tile">
              <div className="tile-label">Blended (DipBuyer&apos;s intrinsic value)</div>
              <div className="tile-value mono">{money(out.blended)}</div>
              <div className="tile-hint">Mean of the models that apply</div>
            </div>
            <div className="tile">
              <div className="tile-label">Lynch ratio</div>
              <div className="tile-value mono" style={{ color: out.ratio === null ? undefined : ratioLabel(out.ratio)[1] }}>
                {out.ratio === null ? "—" : out.ratio.toFixed(2)}
              </div>
              <div className="tile-hint">
                {out.ratio === null ? "(growth + yield) / P/E" : `${ratioLabel(out.ratio)[0]} · P/E ${out.pe?.toFixed(1)}`}
              </div>
            </div>
          </div>
          <details className="explainer" style={{ marginTop: 16 }}>
            <summary>The formulas</summary>
            <p>
              <b>Lynch:</b> fair value = EPS × (growth, capped at {LYNCH_GROWTH_CAP_PCT}%, + dividend yield). The Lynch ratio is (growth + yield) /
              P/E: below 1 is poor, 1.5 is okay, 2 or more is what he looked for (<i>One Up on Wall Street</i>).
            </p>
            <p>
              <b>Graham (revised):</b> value = EPS × (8.5 + 2 × growth, capped at {GRAHAM_GROWTH_CAP_PCT}%) × 4.4 / AAA yield (<i>The Intelligent
              Investor</i>).
            </p>
            <p>
              These are the same functions the DipBuyer engine uses. A rule of thumb, not a forecast: growth rates change, and a low P/E can be a
              value trap. Not a recommendation.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}

export default function FairValuePage() {
  return (
    <Suspense fallback={null}>
      <Calculator />
    </Suspense>
  );
}
