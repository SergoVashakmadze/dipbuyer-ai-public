"use client";

import { use, useEffect, useState } from "react";
import { hashDecision } from "@dipbuyer/chain-monad/browser";
import { getDecision, syntheticSources, type AnalyzeOutput } from "../../../lib/api";
import { ConvictionGauge, CriteriaList, VerdictBadge, VerdictExplainer } from "../../../components/decision-ui";
import { DemoDataBanner } from "../../../components/demo-data-banner";

/** An anchored decision for this symbol, from the committed list the verify page also reads. */
interface AnchoredRef {
  root: string;
  index: number;
  label: string;
  date: string;
  verdict: string;
  /** True when the record shown on this page hashes to the anchored one. */
  sameRecord: boolean;
}

export default function DecisionPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const [data, setData] = useState<AnalyzeOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchorMsg, setAnchorMsg] = useState<string | null>(null);
  const [anchored, setAnchored] = useState<AnchoredRef[] | null>(null);

  useEffect(() => {
    getDecision(symbol)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed"));
  }, [symbol]);

  // Anchored decisions for this symbol (sample decisions with proofs in /monad-batches.json). The live record
  // above is analysed "now", so it is only anchored if it hashes to one of these.
  useEffect(() => {
    if (!data) return;
    const sym = data.record.symbol.toUpperCase();
    let hash: string | null = null;
    try { hash = hashDecision(data.record); } catch { /* leave null: the link still works */ }
    fetch("/monad-batches.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((f: { batches: { root: string; label: string; samples: { index: number; decision: Record<string, unknown> }[] }[] }) => {
        const found: AnchoredRef[] = [];
        for (const b of f.batches) {
          for (const s of b.samples) {
            if (String(s.decision.symbol).toUpperCase() !== sym) continue;
            let same = false;
            try { same = hash !== null && hashDecision(s.decision) === hash; } catch { /* ignore */ }
            found.push({ root: b.root, index: s.index, label: b.label, date: String(s.decision.ts).slice(0, 10), verdict: String(s.decision.verdict), sameRecord: same });
          }
        }
        setAnchored(found);
      })
      .catch(() => setAnchored(null));
  }, [data]);

  const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";
  async function anchor() {
    setAnchorMsg("anchoring…");
    try {
      const r = await fetch(`${BASE}/decisions/${symbol.toUpperCase()}/anchor`, { method: "POST" });
      const b = await r.json();
      setAnchorMsg(b.anchored ? `✅ on-chain: ${b.txid}` : `hash ${b.hash} (${b.reason ?? "not configured"})`);
    } catch {
      setAnchorMsg("anchor failed");
    }
  }

  /**
   * Exports the exact record the hash was computed over. Serialized with the SAME shape the
   * API returned — re-keying or pretty-printing does not matter (the verifier canonicalizes
   * deeply), but dropping fields would change the hash, so we write `record` verbatim.
   */
  function downloadRecord() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data.record, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `decision-${symbol.toUpperCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) return <p style={{ color: "var(--danger)", marginTop: 24 }}>{error} — is the API running on :3001?</p>;
  if (!data) return <p className="muted" style={{ marginTop: 24 }}>Loading {symbol.toUpperCase()}…</p>;

  const r = data.record;
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Decision record</span>
        <h1 style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {r.symbol} <VerdictBadge verdict={r.verdict} large />
        </h1>
        <p>The exact record the verdict was computed from: inputs, checklist, data sources and the hash that proves it.</p>
      </div>
      <DemoDataBanner sources={syntheticSources(r)} />

      <div className="two-col wide-left" style={{ alignItems: "start", marginTop: 16 }}>
        <div>
          <div className="card">
            <VerdictExplainer record={r} />
            <ConvictionGauge score={r.convictionScore} />
            <div className="kv" style={{ marginTop: 10 }}>
              <span>Lynch category</span>
              <b style={{ textTransform: "capitalize" }}>{r.lynchCategory?.replace(/_/g, " ") ?? "—"}</b>
            </div>
            <p className="footnote" style={{ marginTop: 8 }}>Engine rationale: {r.rationale}</p>
          </div>

          {(() => {
            const u = r.understandability;
            const isReal = (s?: string) => !!s && !s.toLowerCase().includes("placeholder");
            if (!u || (!isReal(u.businessSummary) && !isReal(u.growthStory))) return null;
            return (
              <section className="narrative">
                <h2>Lynch narrative</h2>
                {isReal(u.businessSummary) && (
                  <>
                    <h3>Business</h3>
                    <p>{u.businessSummary}</p>
                  </>
                )}
                {isReal(u.growthStory) && (
                  <>
                    <h3>Growth story</h3>
                    <p>{u.growthStory}</p>
                  </>
                )}
              </section>
            );
          })()}

          <h2>Why: the criteria checklist</h2>
          <div className="card">
            <CriteriaList criteria={r.criteria} />
          </div>
        </div>

        <aside className="card" style={{ position: "sticky", top: 88 }}>
          <div className="card-title">Audit trail</div>
          <p className="muted small">SHA-256 of this record. Anchor it on Algorand, then anyone can verify it was not changed.</p>
          <div className="tile" style={{ marginBottom: 14 }}>
            <div className="tile-label">Record hash</div>
            <div className="mono wrap small" style={{ marginTop: 4, fontWeight: 600 }}>{data.hash}</div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <button className="btn btn-brand" onClick={anchor}>Anchor on Algorand</button>
            {/* Independent verification is worthless if the record cannot be obtained — this is
                what the user pastes into /verify (or hands to an auditor). */}
            <button className="btn btn-outline" onClick={downloadRecord}>Download record (JSON)</button>
            <a className="btn btn-outline" href="/verify">Verify a record</a>
            <a className="btn btn-outline" href={`/verify/monad?symbol=${encodeURIComponent(r.symbol)}`}>Verify on Monad</a>
            <a className="btn btn-outline" href={`/stock/${r.symbol}`}>Full research page</a>
          </div>
          {anchorMsg && <p className="muted mono small wrap" style={{ marginTop: 10 }}>{anchorMsg}</p>}
          <div className="card-title" style={{ marginTop: 22 }}>On Monad</div>
          {anchored === null || anchored.length === 0 ? (
            <p className="muted small">
              This live analysis is not anchored on Monad, and no anchored decision for {r.symbol} is listed yet.
              Anchored batches (testnet) can still be checked on the verify page.
            </p>
          ) : (
            <>
              {anchored.some((a) => a.sameRecord) && <p className="verify-good small">✅ This exact record is in an anchored batch.</p>}
              <p className="muted small">
                This page shows a live analysis, which is not itself anchored. Anchored decisions for {r.symbol}:
              </p>
              <div style={{ display: "grid", gap: 6 }}>
                {anchored.map((a) => (
                  <a key={`${a.root}-${a.index}`} className="btn btn-outline" href={`/verify/monad?root=${a.root}&index=${a.index}`}>
                    {a.date} · {a.verdict} · {a.label}
                  </a>
                ))}
              </div>
            </>
          )}
          {r.sellTriggers.length > 0 && (
            <>
              <div className="card-title" style={{ marginTop: 22 }}>What Lynch would watch for</div>
              <div className="chip-row">
                {r.sellTriggers.map((t, i) => (
                  <span key={i} className="perf-chip">{t.replace(/>=/g, "≥")}</span>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
