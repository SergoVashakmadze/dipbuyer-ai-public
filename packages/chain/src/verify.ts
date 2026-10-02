import type { Verifier } from "./index.js";

/**
 * Independently verifies that a hash was anchored in a given Algorand transaction's note —
 * by querying a PUBLIC indexer, with no trust in DipBuyer servers. This is what a partner,
 * regulator or investor runs to confirm the audit trail (the engineering design notes).
 *
 * `fetchImpl` is injectable for offline testing.
 */
export interface IndexerVerifierOptions {
  /** e.g. https://mainnet-idx.algonode.cloud or testnet-idx.algonode.cloud */
  indexerUrl: string;
  fetchImpl?: typeof fetch;
}

/** Decodes a base64 note (as the indexer returns it) to its UTF-8 string. */
export function decodeNote(noteB64: string): string {
  return Buffer.from(noteB64, "base64").toString("utf8");
}

export class IndexerVerifier implements Verifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: IndexerVerifierOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async verify(hash: string, txid: string): Promise<boolean> {
    const url = `${this.opts.indexerUrl.replace(/\/$/, "")}/v2/transactions/${encodeURIComponent(txid)}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) return false;
    const body = (await res.json()) as { transaction?: { note?: string } };
    const note = body.transaction?.note;
    if (!note) return false;
    return decodeNote(note) === hash;
  }
}
