import { describe, expect, it } from "vitest";
import { IndexerVerifier, decodeNote, encodeNote } from "./index.js";

const noteB64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const json = (body: unknown, ok = true): Response => ({ ok, json: async () => body }) as Response;

describe("on-chain verification", () => {
  it("encodeNote/decodeNote round-trip", () => {
    const h = "a".repeat(64);
    expect(decodeNote(Buffer.from(encodeNote(h)).toString("base64"))).toBe(h);
  });

  it("verify() true when the indexer note matches the hash", async () => {
    const hash = "deadbeef".repeat(8);
    const v = new IndexerVerifier({
      indexerUrl: "https://idx.test",
      fetchImpl: (async () => json({ transaction: { note: noteB64(hash) } })) as unknown as typeof fetch,
    });
    expect(await v.verify(hash, "TXID")).toBe(true);
  });

  it("verify() false when the note differs", async () => {
    const v = new IndexerVerifier({
      indexerUrl: "https://idx.test",
      fetchImpl: (async () => json({ transaction: { note: noteB64("other") } })) as unknown as typeof fetch,
    });
    expect(await v.verify("deadbeef".repeat(8), "TXID")).toBe(false);
  });

  it("verify() false on a missing tx / non-200", async () => {
    const v = new IndexerVerifier({
      indexerUrl: "https://idx.test",
      fetchImpl: (async () => json({}, false)) as unknown as typeof fetch,
    });
    expect(await v.verify("x", "TXID")).toBe(false);
  });
});
