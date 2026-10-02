"use client";

import { useEffect, useState } from "react";
import { VerdictBadge } from "../../components/decision-ui";
import { useAuthedFetch } from "../../components/use-authed-fetch";
import { protectPage } from "../../components/protect-page";

interface StoredDecision {
  decisionId: string;
  ts: string;
  symbol: string;
  verdict: string;
  convictionScore: number;
  lynchCategory: string | null;
  mode: string;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

function AuditPage() {
  const [rows, setRows] = useState<StoredDecision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchorMsg, setAnchorMsg] = useState<Record<string, string>>({});
  const authedFetch = useAuthedFetch();

  useEffect(() => {
    authedFetch(`${BASE}/decisions`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Request failed — is the API on :3001?"));
  }, [authedFetch]);

  async function anchor(symbol: string) {
    setAnchorMsg((m) => ({ ...m, [symbol]: "anchoring…" }));
    try {
      const r = await authedFetch(`${BASE}/decisions/${symbol}/anchor`, { method: "POST" });
      const b = await r.json();
      setAnchorMsg((m) => ({
        ...m,
        [symbol]: b.anchored ? `✅ ${b.txid.slice(0, 12)}…` : `hash ${b.hash.slice(0, 12)}… (${b.reason ?? "not configured"})`,
      }));
    } catch {
      setAnchorMsg((m) => ({ ...m, [symbol]: "failed" }));
    }
  }

  return (
    <div>
      <h1>Audit trail</h1>
      <p className="muted">
        Every decision the agent makes is recorded immutably and can be hash-anchored on Algorand for independent
        verification — the provable track record at the heart of DipBuyer AI.
      </p>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {rows && rows.length === 0 && <p className="muted">No decisions recorded yet — run a screen on Opportunities first.</p>}
      {rows && rows.length > 0 && (
        <ul className="criteria" style={{ marginTop: 16 }}>
          {rows.map((d) => (
            <li key={d.decisionId} style={{ alignItems: "center" }}>
              <span>
                <b>{d.symbol}</b> <VerdictBadge verdict={d.verdict} />{" "}
                <span className="muted mono">{d.convictionScore}/100 · {d.lynchCategory ?? "—"}</span>
              </span>
              <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span className="muted mono" style={{ fontSize: "0.75rem" }}>{anchorMsg[d.symbol] ?? new Date(d.ts).toLocaleDateString()}</span>
                <button className="btn" style={{ padding: "4px 10px", fontSize: "0.75rem" }} onClick={() => anchor(d.symbol)}>
                  Anchor
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default protectPage(AuditPage);
