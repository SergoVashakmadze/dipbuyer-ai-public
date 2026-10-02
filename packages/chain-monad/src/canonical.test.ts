import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { canonicalJson, hashDecision } from "./canonical.js";
import { buildMerkleTree, proofFor, verifyProof } from "./merkle.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth and ignores insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    expect(hashDecision({ a: 1, b: 2 })).toBe(hashDecision({ b: 2, a: 1 }));
  });

  it("keeps null and array order, which are part of the record", () => {
    expect(canonicalJson({ x: null, l: [2, 1] })).toBe('{"l":[2,1],"x":null}');
  });

  it("hashes exactly the bytes of the canonical string", () => {
    const d = { symbol: "NWL", verdict: "avoid", criteria: [["roe", "fail", 3.1]] };
    expect(hashDecision(d)).toBe(keccak256(stringToBytes(canonicalJson(d))));
  });

  it("any change to a decision changes its hash and breaks its proof", () => {
    const decisions = Array.from({ length: 7 }, (_, i) => ({ symbol: `S${i}`, verdict: "hold", convictionScore: 40 + i }));
    const tree = buildMerkleTree(decisions.map(hashDecision));
    const proof = proofFor(tree, 3);
    expect(verifyProof(hashDecision(decisions[3]), proof, tree.root)).toBe(true);
    expect(verifyProof(hashDecision({ ...decisions[3], verdict: "buy" }), proof, tree.root)).toBe(false);
  });
});
