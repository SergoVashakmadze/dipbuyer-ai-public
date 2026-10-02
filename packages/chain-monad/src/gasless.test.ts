import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodePacked, keccak256, type Address, type Hex } from "viem";
import { GaslessAnchorer, type UserOpSender } from "./gasless.js";
import { DECISION_REGISTRY_ABI } from "./registry.js";
import { buildMerkleTree, verifyProof } from "./merkle.js";

const REGISTRY = "0x1111111111111111111111111111111111111111" as Address;
const SMART = "0x3333333333333333333333333333333333333333" as Address;
const CONFIG = keccak256(encodePacked(["string"], ["strategy.lynch.json@v0.4.0"]));
const hashes = (n: number): Hex[] => Array.from({ length: n }, (_, i) => keccak256(encodePacked(["string"], [`d-${i}`])));

const publicClient = (anchored = false) => ({ readContract: vi.fn().mockResolvedValue(anchored) }) as never;
function sender(over: Partial<{ success: boolean; reason: string }> = {}) {
  const calls: Array<{ to: Address; data: Hex }[]> = [];
  const s: UserOpSender = {
    account: { address: SMART },
    sendUserOperation: vi.fn(async ({ calls: c }) => {
      calls.push([...c]);
      return "0xdeadbeef" as Hex;
    }),
    waitForUserOperationReceipt: vi.fn(async () => ({ success: over.success ?? true, reason: over.reason, receipt: { transactionHash: "0xfeed" as Hex, blockNumber: 77n } })),
  };
  return { s, calls };
}

describe("GaslessAnchorer", () => {
  it("sends one user operation to the registry whose calldata is anchorBatch(root, config, count)", async () => {
    const decisions = hashes(40);
    const { s, calls } = sender();
    const batch = await new GaslessAnchorer({ publicClient: publicClient(), bundlerClient: s, address: REGISTRY }).anchorBatch(decisions, CONFIG);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]![0]!.to).toBe(REGISTRY);
    const decoded = decodeFunctionData({ abi: DECISION_REGISTRY_ABI, data: calls[0]![0]!.data });
    expect(decoded.functionName).toBe("anchorBatch");
    expect(decoded.args).toEqual([buildMerkleTree(decisions).root, CONFIG, 40]);
    expect(batch).toMatchObject({ txHash: "0xfeed", blockNumber: 77n, decisionCount: 40 });
  });

  it("returns a working proof for every decision", async () => {
    const decisions = hashes(9);
    const { s } = sender();
    const batch = await new GaslessAnchorer({ publicClient: publicClient(), bundlerClient: s, address: REGISTRY }).anchorBatch(decisions, CONFIG);
    decisions.forEach((d, i) => expect(verifyProof(d, batch.proofs[i]!, batch.root)).toBe(true));
  });

  it("refuses an already anchored root before spending a sponsored operation", async () => {
    const { s } = sender();
    await expect(new GaslessAnchorer({ publicClient: publicClient(true), bundlerClient: s, address: REGISTRY }).anchorBatch(hashes(3), CONFIG)).rejects.toThrow(/already anchored/);
    expect(s.sendUserOperation).not.toHaveBeenCalled();
  });

  it("reports a reverted user operation instead of pretending it anchored", async () => {
    const { s } = sender({ success: false, reason: "NotAnchorer()" });
    await expect(new GaslessAnchorer({ publicClient: publicClient(), bundlerClient: s, address: REGISTRY }).anchorBatch(hashes(3), CONFIG)).rejects.toThrow(/reverted: NotAnchorer/);
  });

  it("exposes the smart account address, which is what the registry must allow", () => {
    const { s } = sender();
    expect(new GaslessAnchorer({ publicClient: publicClient(), bundlerClient: s, address: REGISTRY }).anchorerAddress).toBe(SMART);
  });
});
