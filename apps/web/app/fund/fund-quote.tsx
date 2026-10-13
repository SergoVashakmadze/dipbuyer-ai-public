"use client";
import { useState } from "react";

type Quote = { to: string; amountIn: string; amountInUsd: string; amountOut: string; amountOutUsd: string; seconds: number };

export function FundQuote() {
  const [usd, setUsd] = useState("2");
  const [to, setTo] = useState<"usdc" | "mon">("usdc");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/aurora-quote?usd=${encodeURIComponent(usd)}&to=${to}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Quote failed");
      setQuote(body);
    } catch (e) {
      setQuote(null);
      setError(e instanceof Error ? e.message : "Quote failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <label>
          Pay (USDC on Base)
          <br />
          <input type="number" min={1} max={100} value={usd} onChange={(e) => setUsd(e.target.value)} />
        </label>
        <label>
          Receive on Monad
          <br />
          <select value={to} onChange={(e) => setTo(e.target.value as "usdc" | "mon")}>
            <option value="usdc">USDC</option>
            <option value="mon">MON</option>
          </select>
        </label>
        <button className="btn btn-brand" onClick={run} disabled={busy}>
          {busy ? "Asking Aurora…" : "Get live quote"}
        </button>
      </div>
      {error && <p role="alert">Aurora could not quote this right now: {error}</p>}
      {quote && (
        <div style={{ marginTop: 16 }}>
          <p>
            <b>
              {quote.amountIn} USDC on Base → {quote.amountOut} {quote.to.toUpperCase()} on Monad
            </b>{" "}
            (≈ ${Number(quote.amountOutUsd).toFixed(2)}, about {quote.seconds} s)
          </p>
          <p className="footnote">
            Simulation: this is a live dry-run quote from Aurora Intents. No deposit address was issued and no funds moved. In a real
            checkout the next step would be a deposit address to pay into; that step is deliberately not built here.
          </p>
        </div>
      )}
    </div>
  );
}
