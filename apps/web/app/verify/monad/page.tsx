"use client";

/**
 * Verify a decision against Monad — the "provable track record" check for batch-anchored runs.
 *
 * Everything runs in the browser against a public Monad RPC. DipBuyer's API is never called:
 * the decision is hashed here, its Merkle proof is replayed here, and the registry contract is
 * read directly. If we were hostile or gone, the result would not change.
 */

import { useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { hashDecision, verifyProof, MonadVerifier } from "@dipbuyer/chain-monad/browser";

interface Sample {
  index: number;
  decision: Record<string, unknown>;
  proof: Hex[];
}
interface Batch {
  root: Hex;
  txHash: Hex;
  label: string;
  samples: Sample[];
}
interface BatchFile {
  registry: Address;
  batches: Batch[];
}
/** What the chain says about a listed batch. The list file only names batches; this is the truth. */
type ChainState =
  | { status: "checking" }
  | { status: "anchored"; decisionCount: number; anchoredAt: Date; configHash: Hex }
  | { status: "missing" }
  | { status: "error"; message: string };
interface Result {
  decisionHash: Hex;
  localOk: boolean;
  anchored: boolean;
  onChainOk: boolean;
  info: { configHash: Hex; anchoredAt: Date; decisionCount: number; anchoredBy: Address } | null;
  error?: string;
}

/**
 * Envio HyperIndex over the registry's BatchAnchored events (repo: dipbuyer-indexer). It lists every
 * batch ever anchored, which a public RPC cannot (eth_getLogs is capped at ~100 blocks). A Development
 * deployment URL changes when the indexer is redeployed, so it is overridable at build time; if it is
 * down the page falls back to the committed list alone. The chain still decides what each root contains.
 */
const INDEXER_URL = process.env.NEXT_PUBLIC_MONAD_INDEXER_URL ?? "https://indexer.dev.hyperindex.xyz/89b4a5e/v1/graphql";

/** Batch roots the indexer knows about, newest first, or null if it cannot be reached. */
async function listFromIndexer(): Promise<{ root: Hex; txHash: Hex; anchoredAt: number }[] | null> {
  try {
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ Batch(order_by:{anchoredAt:desc}) { id txHash anchoredAt } }" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const rows = ((await res.json()) as { data?: { Batch?: { id: Hex; txHash: Hex; anchoredAt: number }[] } }).data?.Batch;
    return rows ? rows.map((b) => ({ root: b.id, txHash: b.txHash, anchoredAt: b.anchoredAt })) : null;
  } catch {
    return null;
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const explorer = monadTestnet.blockExplorers?.default.url;
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const label = (s: Sample) => `${String(s.decision.symbol)} · ${String(s.decision.ts).slice(0, 10)} · ${String(s.decision.verdict)}`;

export default function VerifyMonadPage() {
  const [file, setFile] = useState<BatchFile | null>(null);
  const [chain, setChain] = useState<Record<string, ChainState>>({});
  const [selected, setSelected] = useState<Batch | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [decisionJson, setDecisionJson] = useState("");
  const [proofJson, setProofJson] = useState("");
  const [root, setRoot] = useState("");
  const [registry, setRegistry] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  function pick(f: BatchFile, b: Batch, s: Sample) {
    setSelected(b);
    setDecisionJson(pretty(s.decision));
    setProofJson(pretty(s.proof));
    setRoot(b.root);
    setRegistry(f.registry);
    setResult(null);
    setInput(null);
  }

  useEffect(() => {
    fetch("/monad-batches.json")
      .then((r) => (r.ok ? (r.json() as Promise<BatchFile>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async (manifest) => {
        // Batches the indexer lists that the committed file does not carry samples for are still shown
        // (checkable by pasting a decision and proof); the committed file supplies the sample decisions.
        const indexedBatches = await listFromIndexer();
        setIndexed(indexedBatches ? indexedBatches.length : null);
        const known = new Set(manifest.batches.map((b) => b.root.toLowerCase()));
        const extra: Batch[] = (indexedBatches ?? [])
          .filter((b) => !known.has(b.root.toLowerCase()))
          .map((b) => ({ root: b.root, txHash: b.txHash, label: `Anchored ${new Date(b.anchoredAt * 1000).toISOString().slice(0, 10)} (no sample decisions listed)`, samples: [] }));
        const f: BatchFile = { ...manifest, batches: [...manifest.batches, ...extra] };
        setFile(f);
        const first = f.batches.find((b) => b.samples.length > 0);
        if (first?.samples[0]) pick(f, first, first.samples[0]);

        // The list says which batches exist; the chain says whether they do, and what is in them.
        const verifier = new MonadVerifier({
          publicClient: createPublicClient({ chain: monadTestnet, transport: http() }) as never,
          address: f.registry,
        });
        setChain(Object.fromEntries(f.batches.map((b) => [b.root, { status: "checking" } as ChainState])));
        for (const b of f.batches) {
          verifier
            .batchInfo(b.root)
            .then((info) =>
              setChain((c) => ({
                ...c,
                [b.root]: info ? { status: "anchored", decisionCount: info.decisionCount, anchoredAt: info.anchoredAt, configHash: info.configHash } : { status: "missing" },
              })),
            )
            .catch((e: Error) => setChain((c) => ({ ...c, [b.root]: { status: "error", message: e.message } })));
        }
      })
      .catch((e: Error) => setLoadError(`Could not load the list of anchored batches (${e.message}). You can still paste your own below.`));
  }, []);

  /** Flips the verdict in the box so you can watch the check refuse an altered record. */
  function tamper() {
    try {
      const d = JSON.parse(decisionJson) as Record<string, unknown>;
      d.verdict = d.verdict === "buy" ? "avoid" : "buy";
      setDecisionJson(pretty(d));
      setResult(null);
      setInput(null);
    } catch {
      setInput("The decision box is not valid JSON, so there is nothing to alter.");
    }
  }

  async function run() {
    setResult(null);
    setInput(null);

    let decision: unknown;
    let proof: unknown;
    try {
      decision = JSON.parse(decisionJson);
    } catch (e) {
      return setInput(`The decision is not valid JSON: ${(e as Error).message}`);
    }
    try {
      proof = JSON.parse(proofJson);
    } catch (e) {
      return setInput(`The proof is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(proof) || !proof.every((p) => typeof p === "string" && HASH.test(p))) {
      return setInput("The proof must be a JSON array of 0x-prefixed 32-byte hashes.");
    }
    if (!HASH.test(root.trim())) return setInput("The batch root must be 0x followed by 64 hex characters.");
    if (!ADDRESS.test(registry.trim())) return setInput("The registry address must be 0x followed by 40 hex characters.");

    const r = root.trim() as Hex;
    const p = proof as Hex[];
    const decisionHash = hashDecision(decision);
    const localOk = verifyProof(decisionHash, p, r);

    setBusy(true);
    try {
      const verifier = new MonadVerifier({
        publicClient: createPublicClient({ chain: monadTestnet, transport: http() }) as never,
        address: registry.trim() as Address,
      });
      const anchored = await verifier.isAnchored(r);
      const info = anchored ? await verifier.batchInfo(r) : null;
      const onChainOk = anchored ? await verifier.verifyDecision(r, decisionHash, p) : false;
      setResult({ decisionHash, localOk, anchored, onChainOk, info });
    } catch (e) {
      setResult({ decisionHash, localOk, anchored: false, onChainOk: false, info: null, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const verified = result && !result.error && result.localOk && result.anchored && result.onChainOk;

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>Verify a decision on Monad</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        A whole run of decisions is anchored on Monad as <b>one Merkle root</b>. To check a single
        decision, this page hashes it <b>in your browser</b>, replays its inclusion proof up to the
        root, then asks the registry contract on Monad testnet whether that root was anchored and
        whether the proof holds. DipBuyer&apos;s servers are not contacted — you are not asked to trust us.
      </p>

      {file && (
        <>
          <h2 style={{ marginBottom: 8 }}>Anchored batches</h2>
          <p className="muted" style={{ lineHeight: 1.6, marginTop: 0 }}>
            Each row is read from the registry on Monad testnet when this page loads. The list only names the
            batches; their status, size and date come from the chain.{" "}
            {indexed !== null
              ? `The batch list is indexed by Envio HyperIndex (${indexed} batches found).`
              : "The Envio indexer could not be reached, so only the committed list is shown."}
          </p>
          {file.batches.map((b) => {
            const c = chain[b.root] ?? { status: "checking" as const };
            const active = selected?.root === b.root;
            return (
              <div key={b.root} className="card" style={{ marginBottom: 12, borderColor: active ? "var(--accent, currentColor)" : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <b>{b.label}</b>
                  {c.status === "anchored" && <span className="verify-good">✅ anchored on Monad</span>}
                  {c.status === "checking" && <span className="muted">checking the chain…</span>}
                  {c.status === "missing" && <span className="verify-bad">❌ not found on the registry</span>}
                  {c.status === "error" && <span className="verify-warn">⚠️ could not reach Monad</span>}
                </div>
                <div className="kv"><span>Root</span><b className="mono wrap">{b.root}</b></div>
                {c.status === "anchored" && (
                  <>
                    <div className="kv"><span>Decisions</span><b>{c.decisionCount.toLocaleString()}</b></div>
                    <div className="kv"><span>Anchored</span><b>{c.anchoredAt.toUTCString()}</b></div>
                    <div className="kv"><span>Strategy config hash</span><b className="mono wrap">{c.configHash}</b></div>
                  </>
                )}
                <div className="kv">
                  <span>Transaction</span>
                  <b className="mono wrap">
                    {explorer ? (
                      <a href={`${explorer}/tx/${b.txHash}`} target="_blank" rel="noreferrer">{short(b.txHash)}</a>
                    ) : (
                      short(b.txHash)
                    )}
                  </b>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {b.samples.map((s) => (
                    <button key={s.index} className="btn" onClick={() => pick(file, b, s)}>{label(s)}</button>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
      {loadError && <p className="verify-warn">{loadError}</p>}

      <label className="field">
        <span>Decision record (JSON)</span>
        <textarea value={decisionJson} onChange={(e) => setDecisionJson(e.target.value)} rows={9} spellCheck={false} className="mono" />
      </label>
      <label className="field">
        <span>Inclusion proof (JSON array of hashes)</span>
        <textarea value={proofJson} onChange={(e) => setProofJson(e.target.value)} rows={4} spellCheck={false} className="mono" />
      </label>
      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <label className="field">
          <span>Batch root</span>
          <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} className="mono" />
        </label>
        <label className="field">
          <span>Registry contract</span>
          <input value={registry} onChange={(e) => setRegistry(e.target.value)} spellCheck={false} className="mono" />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={run} disabled={busy || !decisionJson.trim() || !proofJson.trim() || !root.trim() || !registry.trim()}>
          {busy ? "Checking Monad…" : "Verify"}
        </button>
        <button className="btn" onClick={tamper} disabled={busy || !decisionJson.trim()}>
          Alter the verdict, then verify again
        </button>
      </div>

      {input && <p className="verify-bad" style={{ marginTop: 16 }}>{input}</p>}

      {result && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>
            {result.error ? (
              <span className="verify-warn">⚠️ Could not complete</span>
            ) : verified ? (
              <span className="verify-good">✅ Verified</span>
            ) : (
              <span className="verify-bad">❌ Does not verify</span>
            )}
          </h2>

          {result.error ? (
            <p>Could not reach Monad testnet: {result.error}</p>
          ) : verified ? (
            <p>
              This decision is in a batch that was anchored on Monad
              {result.info ? ` on ${result.info.anchoredAt.toUTCString()}` : ""}. It has not been altered since.
            </p>
          ) : !result.localOk ? (
            <p>
              The proof does <b>not</b> lead from this decision to that root. Either the record was altered, or
              the proof or root belong to something else.
            </p>
          ) : !result.anchored ? (
            <p>The proof is internally consistent, but this root was <b>never anchored</b> on that registry.</p>
          ) : (
            <p>The registry contract rejected this decision for that batch.</p>
          )}

          <div className="kv"><span>Decision hash (computed here)</span><b className="mono wrap">{result.decisionHash}</b></div>
          <div className="kv"><span>Proof replays to the root</span><b>{result.localOk ? "yes" : "no"}</b></div>
          <div className="kv"><span>Root anchored on Monad</span><b>{result.error ? "—" : result.anchored ? "yes" : "no"}</b></div>
          <div className="kv"><span>Contract accepts the proof</span><b>{result.error ? "—" : result.onChainOk ? "yes" : "no"}</b></div>
          {result.info && (
            <>
              <div className="kv"><span>Decisions in the batch</span><b>{result.info.decisionCount.toLocaleString()}</b></div>
              <div className="kv"><span>Strategy config hash</span><b className="mono wrap">{result.info.configHash}</b></div>
              <div className="kv"><span>Anchored by</span><b className="mono wrap">{result.info.anchoredBy}</b></div>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ lineHeight: 1.6, marginTop: 24 }}>
        What this proves: this exact decision existed, unchanged, when the batch was anchored, under the strategy
        config whose hash is stored with it. What it does not prove: that the decision was any good, or that the
        inputs were real market data. Only the root, the config hash and a count are on chain — no company data,
        no holdings, no personal data. This is Monad <b>testnet</b>.
      </p>
    </div>
  );
}
