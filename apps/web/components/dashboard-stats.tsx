"use client";

import { useEffect, useState } from "react";
import { useAuthedFetch } from "./use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Health {
  ok: boolean;
  mode: string;
  execution: string;
  fundamentals: string;
}
interface Report {
  totalDecisions: number;
  byVerdict: Record<string, number>;
}

/** Quiet system-status strip: reachable API, data source, mode and decision counts. */
export function DashboardStats() {
  const [health, setHealth] = useState<Health | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [down, setDown] = useState(false);
  const authedFetch = useAuthedFetch();

  useEffect(() => {
    // /health is @Public — it alone decides whether the API is reachable.
    fetch(`${BASE}/health`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))))
      .then(setHealth)
      .catch(() => setDown(true));
    // /reports/audit is guarded — best-effort: 401 when signed out just hides those pills.
    authedFetch(`${BASE}/reports/audit`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setReport)
      .catch(() => setReport(null));
  }, [authedFetch]);

  return (
    <div className="status-row" aria-live="polite">
      <span className="status-pill">
        <span className={down ? "dot down" : "dot"} /> API <b>{down ? "offline" : health ? "online" : "checking…"}</b>
      </span>
      {health && (
        <>
          <span className="status-pill">
            Data <b>{health.fundamentals}</b>
          </span>
          <span className="status-pill">
            Mode <b>{health.mode.replace(/_/g, " ").toLowerCase()}</b>
          </span>
        </>
      )}
      {report && (
        <span className="status-pill">
          Decisions <b>{report.totalDecisions}</b> · buys <b>{report.byVerdict["buy"] ?? 0}</b>
        </span>
      )}
    </div>
  );
}
