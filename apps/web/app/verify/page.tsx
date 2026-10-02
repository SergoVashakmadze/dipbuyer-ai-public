"use client";

/**
 * Independent verification — the "provable track record" tool the design notes.
 *
 * Everything here runs IN THE BROWSER against a public Algorand indexer. DipBuyer's API is
 * never called, deliberately: if we recomputed the hash server-side, the user would be
 * trusting us to tell them whether to trust us. The only inputs are the record they hold and
 * the public chain, so the result stands even if DipBuyer is hostile or gone.
 */

import { useState } from "react";
import type { DecisionRecord } from "@dipbuyer/shared";
import { checkAnchor, type AnchorCheck } from "@dipbuyer/chain/isomorphic";

const INDEXERS: Record<string, string> = {
  mainnet: "https://mainnet-idx.algonode.cloud",
  testnet: "https://testnet-idx.algonode.cloud",
};

const SYNTHETIC = ["in-memory-demo", "backtest-synthetic"];

export default function VerifyPage() {
  const [json, setJson] = useState("");
  const [txid, setTxid] = useState("");
  const [network, setNetwork] = useState<keyof typeof INDEXERS>("mainnet");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnchorCheck | null>(null);
  const [record, setRecord] = useState<DecisionRecord | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  async function run() {
    setParseError(null);
    setResult(null);
    setRecord(null);

    let parsed: DecisionRecord;
    try {
      parsed = JSON.parse(json) as DecisionRecord;
    } catch (e) {
      setParseError(`That is not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("decisionId" in parsed)) {
      setParseError("That JSON does not look like a DecisionRecord (no decisionId field).");
      return;
    }

    setBusy(true);
    try {
      setRecord(parsed);
      setResult(await checkAnchor(parsed, txid.trim(), INDEXERS[network]!));
    } finally {
      setBusy(false);
    }
  }

  const syntheticSources = [
    ...new Set((record?.dataProvenance ?? []).map((p) => p.source).filter((s) => SYNTHETIC.includes(s))),
  ];

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>Verify a decision</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Paste a DecisionRecord and the Algorand transaction it was anchored in. The hash is
        recomputed <b>in your browser</b> and compared against the note stored on-chain, read
        directly from a public indexer. DipBuyer&apos;s servers are not contacted — you are not
        asked to trust us.
      </p>

      <label className="field">
        <span>DecisionRecord JSON</span>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder='{"decisionId":"…","symbol":"AAPL", …}'
          className="mono"
        />
      </label>

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <label className="field">
          <span>Algorand transaction ID</span>
          <input value={txid} onChange={(e) => setTxid(e.target.value)} spellCheck={false} className="mono" />
        </label>
        <label className="field">
          <span>Network</span>
          <select value={network} onChange={(e) => setNetwork(e.target.value as keyof typeof INDEXERS)}>
            <option value="mainnet">mainnet</option>
            <option value="testnet">testnet</option>
          </select>
        </label>
      </div>

      <button className="btn" onClick={run} disabled={busy || !json.trim() || !txid.trim()}>
        {busy ? "Verifying…" : "Verify"}
      </button>

      {parseError && <p className="verify-bad" style={{ marginTop: 16 }}>{parseError}</p>}

      {result && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>
            {result.error ? (
              <span className="verify-warn">⚠️ Could not complete</span>
            ) : result.matches ? (
              <span className="verify-good">✅ Verified</span>
            ) : (
              <span className="verify-bad">❌ Does not match</span>
            )}
          </h2>

          {result.error ? (
            <p>{result.error}</p>
          ) : result.matches ? (
            <p>
              This record is byte-for-byte what was anchored on Algorand
              {result.confirmedRound ? ` in round ${result.confirmedRound}` : ""}
              {result.roundTime ? ` on ${new Date(result.roundTime * 1000).toUTCString()}` : ""}. It has
              not been altered since.
            </p>
          ) : (
            <p>
              The hash of this record does <b>not</b> match what that transaction anchored. Either the
              record was modified after anchoring, or it belongs to a different transaction.
            </p>
          )}

          <div className="kv"><span>Recomputed locally</span><b className="mono wrap">{result.localHash}</b></div>
          <div className="kv"><span>Found on-chain</span><b className="mono wrap">{result.onChainHash ?? "—"}</b></div>

          {/* A hash match proves integrity, NOT that the inputs were real market data. */}
          {result.matches && syntheticSources.length > 0 && (
            <div className="demo-banner" style={{ marginTop: 16 }}>
              <strong>Verified — but built on demo data.</strong> The hash is genuine and unaltered,
              yet this decision was computed from synthetic fixtures ({syntheticSources.join(", ")}),
              not real fundamentals. Integrity is not the same as accuracy.
            </div>
          )}
          {result.matches && (record?.dataProvenance ?? []).length === 0 && (
            <div className="demo-banner" style={{ marginTop: 16 }}>
              <strong>No provenance recorded.</strong> This record does not state where its data came
              from, so the hash confirms only that it is unaltered — not that it reflects real market data.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
