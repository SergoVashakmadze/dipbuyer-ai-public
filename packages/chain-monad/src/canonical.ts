import { keccak256, stringToBytes, type Hex } from "viem";

/**
 * How a decision record becomes a Merkle leaf input. The anchoring script and the public verify
 * page both import this, so they cannot disagree: if they did, every honest proof would fail.
 */

/** JSON with object keys sorted at every depth, so the same decision always serialises the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** keccak256 of the canonical JSON: the decision hash that goes into a batch. */
export function hashDecision(decision: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(decision)));
}
