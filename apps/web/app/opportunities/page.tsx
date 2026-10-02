"use client";

import { useEffect, useMemo, useState } from "react";
import { getScreener, isSyntheticSourceId, type AnalyzeOutput, type ScreenerResult, type ScreenerRow } from "../../lib/api";
import { DecisionCard } from "../../components/decision-ui";
import { DemoDataBanner } from "../../components/demo-data-banner";
import { ScreenerTable, TickerSearch, toCsv, useWatchlist } from "../../components/research-ui";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { IDEAS } from "../../lib/ideas";
import { protectPage } from "../../components/protect-page";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

const WATCHLIST = "watchlist";

function OpportunitiesPage() {
  const [data, setData] = useState<ScreenerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idea, setIdea] = useState("dip-buys");
  const watchlist = useWatchlist();

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("idea");
    if (fromUrl) setIdea(fromUrl);
    getScreener()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed"));
  }, []);

  const choose = (id: string) => {
    setIdea(id);
    const url = new URL(window.location.href);
    url.searchParams.set("idea", id);
    window.history.replaceState(null, "", url);
  };

  const active = IDEAS.find((i) => i.id === idea);
  const rows = useMemo(() => {
    if (!data) return [];
    if (idea === WATCHLIST) return data.rows.filter((r) => watchlist.symbols.includes(r.symbol));
    const i = active ?? IDEAS[0]!;
    const out = data.rows.filter(i.filter);
    return i.sort ? out.sort(i.sort) : out;
  }, [data, idea, active, watchlist.symbols]);

  const synthetic = useMemo(
    () => [...new Set((data?.rows ?? []).flatMap((r) => r.sources).filter(isSyntheticSourceId))],
    [data],
  );

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `dipbuyer-${idea}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const offUniverseWatch = data ? watchlist.symbols.filter((s) => !data.rows.some((r) => r.symbol === s)) : [];

  return (
    <div>
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <span className="eyebrow">Research</span>
          <h1>Stock ideas</h1>
          <p>
            Idea lists built on the Lynch engine&apos;s verdicts, with the evidence a dip buyer checks next: distance from the 52-week
            high, price against intrinsic value, and a quality profile.
          </p>
        </div>
        <TickerSearch placeholder="Research any ticker, e.g. NKE" />
      </div>

      <div className="idea-rail" role="tablist" aria-label="Idea lists" style={{ marginTop: 16 }}>
        {IDEAS.map((i) => (
          <button key={i.id} type="button" role="tab" aria-selected={idea === i.id} className={`idea-card ${i.hue}${idea === i.id ? " active" : ""}`} onClick={() => choose(i.id)}>
            <span className="tag">{i.tag}</span>
            <h3>{i.label}</h3>
            <p>{i.description}</p>
            <div className="foot">
              <span className="count">{data ? `${data.rows.filter(i.filter).length} stocks` : "…"}</span>
              <span className="go">→</span>
            </div>
          </button>
        ))}
        <button type="button" role="tab" aria-selected={idea === WATCHLIST} className={`idea-card hue-rose${idea === WATCHLIST ? " active" : ""}`} onClick={() => choose(WATCHLIST)}>
          <span className="tag">Starred</span>
          <h3>Your watchlist</h3>
          <p>Stocks you starred on research pages, saved in this browser.</p>
          <div className="foot">
            <span className="count">{watchlist.symbols.length} stocks</span>
            <span className="go">→</span>
          </div>
        </button>
      </div>

      <DemoDataBanner sources={synthetic} />

      <div className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden", boxShadow: "var(--shadow)" }}>
        <div className="table-head">
          <div>
            <div className="card-title">{idea === WATCHLIST ? "Your watchlist" : active?.label}</div>
            <div className="muted small">
              {idea === WATCHLIST ? "Starred on research pages. Saved in this browser." : active?.description}
              {data && ` ${rows.length} ${rows.length === 1 ? "stock" : "stocks"}.`}
            </div>
          </div>
          <button type="button" className="btn btn-outline" onClick={download} disabled={!rows.length}>
            Download CSV
          </button>
        </div>
        {error ? (
          <p style={{ color: "var(--danger)", padding: 18 }}>{error}: is the API running on :3001?</p>
        ) : !data ? (
          <p className="muted" style={{ padding: 18 }}>Screening the universe… the first run after a restart takes a minute.</p>
        ) : rows.length === 0 ? (
          <p className="muted" style={{ padding: 18 }}>
            {idea === WATCHLIST ? "Nothing on your watchlist from this universe yet." : "No stocks match this idea today."}
          </p>
        ) : (
          <ScreenerTable rows={rows} />
        )}
        {idea === WATCHLIST && offUniverseWatch.length > 0 && (
          <p className="muted small" style={{ padding: "0 18px 14px" }}>
            Outside the screened universe:{" "}
            {offUniverseWatch.map((s, i) => (
              <span key={s}>
                {i > 0 && ", "}
                <a href={`/stock/${s}`}>{s}</a>
              </span>
            ))}
          </p>
        )}
      </div>
      {data && (
        <p className="muted small" style={{ marginTop: 8 }}>
          {data.universe.length} names screened · refreshed {new Date(data.generatedAt).toLocaleString()}
          {data.unavailable.length > 0 && ` · no data for ${data.unavailable.join(", ")}`}
        </p>
      )}

      <CustomScreen />
    </div>
  );
}

/** The original ad-hoc screen: any tickers, buy candidates only (POST /decisions/screen). */
function CustomScreen() {
  const [symbols, setSymbols] = useState("AAPL, MSFT, RICH");
  const [results, setResults] = useState<AnalyzeOutput[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authedFetch = useAuthedFetch();

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const list = symbols.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await authedFetch(`${BASE}/decisions/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: list }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      setResults((await res.json()) as AnalyzeOutput[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed — is the API running on :3001?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 40 }}>
      <h2 style={{ marginTop: 0 }}>Screen your own tickers</h2>
      <p className="muted">Enter tickers to screen against Peter Lynch&apos;s criteria. Only buy candidates are shown, ranked by conviction.</p>
      <input className="symbols" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="AAPL, MSFT, ..." />
      <button className="btn" onClick={run} disabled={loading}>
        {loading ? "Screening…" : "Screen"}
      </button>
      {error && <p style={{ color: "var(--danger)", marginTop: 16 }}>{error}</p>}
      {results && results.length === 0 && !error && (
        <p className="muted" style={{ marginTop: 16 }}>No buy candidates — none of those names pass the Lynch criteria right now.</p>
      )}
      {results && results.length > 0 && (
        <div className="grid" style={{ marginTop: 20 }}>
          {results.map((r) => (
            <DecisionCard key={r.record.symbol} record={r.record} hash={r.hash} />
          ))}
        </div>
      )}
    </section>
  );
}

export default protectPage(OpportunitiesPage);
