"use client";

import { useEffect, useState } from "react";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { protectPage } from "../../components/protect-page";

interface AuditReport {
  generatedAt: string;
  methodology: string;
  strategyConfigVersion: string;
  strategyConfigHash: string;
  mode: string;
  execution: string;
  totalDecisions: number;
  byVerdict: Record<string, number>;
  byCategory: Record<string, number>;
  note: string;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

function ReportsPage() {
  const [r, setR] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authedFetch = useAuthedFetch();

  useEffect(() => {
    authedFetch(`${BASE}/reports/audit`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`API ${res.status}`);
        return res.json();
      })
      .then(setR)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed — is the API on :3001?"));
  }, [authedFetch]);

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Compliance &amp; audit report</h1>
      <p className="muted">Regulator / partner / investor-facing summary: methodology, reproducibility hash, and decision history.</p>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {r && (
        <div className="card">
          <div className="kv"><span>Methodology</span><b>{r.methodology}</b></div>
          <div className="kv"><span>Config version</span><b className="mono">{r.strategyConfigVersion}</b></div>
          <div className="kv"><span>Config hash</span><b className="mono">{r.strategyConfigHash.slice(0, 20)}…</b></div>
          <div className="kv"><span>Mode / execution</span><b>{r.mode} / {r.execution}</b></div>
          <div className="kv"><span>Total decisions</span><b className="mono">{r.totalDecisions}</b></div>
          <h2 style={{ fontSize: "1rem" }}>By verdict</h2>
          <ul className="criteria">
            {Object.entries(r.byVerdict).map(([k, v]) => (
              <li key={k}><span>{k}</span><span className="mono">{v}</span></li>
            ))}
          </ul>
          <h2 style={{ fontSize: "1rem" }}>By Lynch category</h2>
          <ul className="criteria">
            {Object.entries(r.byCategory).map(([k, v]) => (
              <li key={k}><span>{k}</span><span className="mono">{v}</span></li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: "0.75rem", marginTop: 12 }}>{r.note}</p>
          <p className="muted" style={{ fontSize: "0.72rem" }}>Generated {new Date(r.generatedAt).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

export default protectPage(ReportsPage);
