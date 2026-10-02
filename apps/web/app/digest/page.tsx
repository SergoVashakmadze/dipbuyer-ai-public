"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthedFetch } from "../../components/use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface Preview {
  subject: string;
  html: string;
  text: string;
  optIn: boolean;
  email: string | null;
  provider: string;
}

export default function DigestPage() {
  const authedFetch = useAuthedFetch();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const r = await authedFetch(`${BASE}${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { message?: string }).message ?? (body as { error?: { message?: string } }).error?.message ?? `API ${r.status}`);
      return body as T;
    },
    [authedFetch],
  );

  const load = useCallback(async () => {
    try {
      setPreview(await call<Preview>("/digest/preview"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOptIn(optIn: boolean) {
    setBusy("sub");
    setMsg(null);
    try {
      await call("/digest/subscription", { method: "PUT", body: JSON.stringify({ optIn }) });
      await load();
      setMsg(optIn ? "Subscribed. The digest arrives once a week." : "Unsubscribed. You will not get the digest.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await call<{ sentTo: string; provider: string }>("/digest/send-test", { method: "POST" });
      setMsg(r.provider === "log" ? "Email sending is not connected on this server yet, so the test was only logged." : `Sent to ${r.sentTo}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Weekly digest</span>
        <h1>
          Your week, <span className="grad-text">in one email</span>
        </h1>
        <p>
          Once a week: your portfolio, what the agent did, your watchlist alerts, the stocks the Lynch engine rates a buy, and the week&apos;s biggest
          insider buying. Off until you switch it on.
        </p>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {preview && (
        <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
          <div>
            <b>{preview.optIn ? "You are subscribed" : "You are not subscribed"}</b>
            <div className="muted small">
              {preview.email ? `Sent to ${preview.email}` : "No email address on your account yet (sign in with an email-based login)."}
              {preview.provider === "log" && " · Email sending is not connected on this server yet."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={`btn ${preview.optIn ? "btn-outline" : "btn-brand"}`} onClick={() => void setOptIn(!preview.optIn)} disabled={busy !== null}>
              {busy === "sub" ? "Saving…" : preview.optIn ? "Unsubscribe" : "Subscribe"}
            </button>
            <button className="btn btn-outline" onClick={() => void sendTest()} disabled={busy !== null || !preview.email}>
              {busy === "test" ? "Sending…" : "Send me a test"}
            </button>
          </div>
        </div>
      )}
      {msg && <p className="muted small" style={{ marginTop: 8 }}>{msg}</p>}

      {preview && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-title">This week&apos;s digest</div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Subject: <b>{preview.subject}</b>
          </p>
          <iframe
            title="Digest preview"
            srcDoc={preview.html}
            sandbox=""
            style={{ width: "100%", height: 620, border: "1px solid var(--border)", borderRadius: 12, background: "#fff" }}
          />
        </div>
      )}
    </div>
  );
}
