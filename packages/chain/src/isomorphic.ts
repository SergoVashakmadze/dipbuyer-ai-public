/**
 * Browser-safe verification primitives — NO node: imports, so this module can be bundled
 * into a web client.
 *
 * Why this exists: independent verification means the verifier must not trust DipBuyer.
 * If the browser posted a record to our API and rendered whatever verdict came back, the
 * user would be trusting us about whether to trust us. Recomputing the hash locally with
 * Web Crypto and querying a PUBLIC Algorand indexer directly removes us from the loop
 * entirely — the only inputs are the record the user holds and the public chain.
 *
 * The canonicalization here is shared with the Node path (see index.ts), and a test asserts
 * both produce byte-identical hashes. If they ever diverge, verification silently breaks.
 */
import type { DecisionRecord } from "@dipbuyer/shared";

/** Recursively sorts object keys so serialization is order-independent (deep). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * The exact string that gets hashed. Single source of truth for both the Node and Web Crypto
 * paths — `chainAnchorTxid` is excluded because it is assigned AFTER the hash is computed.
 */
export function canonicalStringOf(record: DecisionRecord): string {
  const { chainAnchorTxid: _omit, ...canonical } = record;
  return JSON.stringify(canonicalize(canonical));
}

/** sha-256 hex via Web Crypto — available in browsers and Node 18+. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Isomorphic equivalent of hashDecision(). Same output, no node:crypto. */
export async function hashDecisionAsync(record: DecisionRecord): Promise<string> {
  return sha256Hex(canonicalStringOf(record));
}

/** Decodes a base64 note (as the indexer returns it) without Buffer. */
export function decodeNoteIsomorphic(noteB64: string): string {
  const bin = globalThis.atob(noteB64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface AnchorCheck {
  /** Did the note in that transaction equal the locally-recomputed hash? */
  matches: boolean;
  /** Hash recomputed from the record the user supplied. */
  localHash: string;
  /** Hash found on-chain, or null when the tx has no note / was not found. */
  onChainHash: string | null;
  /** Round the transaction was confirmed in — the timestamp proof. */
  confirmedRound: number | null;
  /** Unix seconds of that round, when the indexer reports it. */
  roundTime: number | null;
  error: string | null;
}

/**
 * Confirms a record's hash was anchored in a given Algorand transaction, querying a public
 * indexer directly. Returns a structured result rather than a bare boolean so the UI can
 * explain WHY a check failed — "tx not found" and "hash mismatch" mean very different things
 * and conflating them would let a tampered record look like a typo.
 */
export async function checkAnchor(
  record: DecisionRecord,
  txid: string,
  indexerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnchorCheck> {
  const localHash = await hashDecisionAsync(record);
  const base = { localHash, onChainHash: null, confirmedRound: null, roundTime: null };
  const url = `${indexerUrl.replace(/\/$/, "")}/v2/transactions/${encodeURIComponent(txid)}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    return { ...base, matches: false, error: `Could not reach indexer: ${(e as Error).message}` };
  }
  // Verified against the live algonode indexer (2026-07-19): a MALFORMED txid returns 400,
  // not 404 — so a simple typo must not surface as an opaque "HTTP 400".
  if (res.status === 400) {
    return { ...base, matches: false, error: "That is not a valid Algorand transaction ID." };
  }
  if (res.status === 404) {
    return {
      ...base,
      matches: false,
      error: "Transaction not found on this network — check you selected the right one (mainnet/testnet).",
    };
  }
  if (!res.ok) {
    return { ...base, matches: false, error: `Indexer returned HTTP ${res.status}.` };
  }
  const body = (await res.json()) as {
    transaction?: { note?: string; "confirmed-round"?: number; "round-time"?: number };
  };
  const tx = body.transaction;
  if (!tx) return { ...base, matches: false, error: "Indexer returned no transaction." };

  const confirmedRound = tx["confirmed-round"] ?? null;
  const roundTime = tx["round-time"] ?? null;
  if (!tx.note) {
    return {
      ...base,
      matches: false,
      confirmedRound,
      roundTime,
      error: "That transaction carries no note, so it anchors nothing.",
    };
  }
  let onChainHash: string;
  try {
    onChainHash = decodeNoteIsomorphic(tx.note);
  } catch {
    return { ...base, matches: false, confirmedRound, roundTime, error: "Note is not valid base64." };
  }
  return {
    matches: onChainHash === localHash,
    localHash,
    onChainHash,
    confirmedRound,
    roundTime,
    error: null,
  };
}
