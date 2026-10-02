/**
 * Standalone DecisionRecord verifier — the "provable track record" tool. Given a DecisionRecord
 * JSON and an Algorand txid, it recomputes the hash and confirms it matches the on-chain note
 * via a PUBLIC indexer, WITHOUT trusting DipBuyer servers. Run by partners / regulators /
 * investors to independently verify the audit trail. See the engineering design notes
 *
 * Usage: verifier <decision-record.json> <txid> [indexerUrl]
 */
import { readFileSync } from "node:fs";
import { hashDecision, IndexerVerifier } from "@dipbuyer/chain";
import type { DecisionRecord } from "@dipbuyer/shared";

async function main() {
  const [path, txid, indexerUrl] = process.argv.slice(2);
  if (!path || !txid) {
    console.error("usage: verifier <decision-record.json> <algorand-txid> [indexerUrl]");
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(path, "utf8")) as DecisionRecord;
  const localHash = hashDecision(record);
  const verifier = new IndexerVerifier({
    indexerUrl: indexerUrl ?? "https://mainnet-idx.algonode.cloud",
  });
  const ok = await verifier.verify(localHash, txid);
  console.log(`Local hash: ${localHash}`);
  console.log(`On-chain match for tx ${txid}: ${ok ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`);

  // A hash match proves the record is UNTAMPERED — it says nothing about whether the
  // underlying data was real. A decision built on demo fixtures verifies just as cleanly,
  // so provenance must be reported alongside, or "VERIFIED" is misleading.
  const sources = [...new Set((record.dataProvenance ?? []).map((p) => p.source))];
  const synthetic = sources.filter((s) => s === "in-memory-demo" || s === "backtest-synthetic");
  console.log(`Data sources: ${sources.length ? sources.join(", ") : "(none recorded)"}`);
  if (synthetic.length) {
    console.log(
      `⚠️  This record was derived from SYNTHETIC data (${synthetic.join(", ")}). The hash is` +
        ` genuine, but the decision is not an analysis of the real company.`,
    );
  } else if (!sources.length) {
    console.log("⚠️  No data provenance recorded — cannot confirm this came from real market data.");
  }
  process.exit(ok ? 0 : 1);
}

void main();
