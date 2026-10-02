import { createPublicClient, encodeFunctionData, http, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { createBundlerClient, createPaymasterClient, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { DECISION_REGISTRY_ABI, MonadVerifier, type AnchoredBatch } from "./registry.js";
import { buildMerkleTree, proofFor, type DecisionHash } from "./merkle.js";

/**
 * Gasless anchoring: the batch root goes to the registry as an ERC-4337 UserOperation whose gas a
 * paymaster sponsors, so the anchoring account never needs to hold MON.
 *
 * The registry only accepts roots from allowlisted anchorers, so the smart account's address must
 * first be allowed by the owner (`setAnchorer`, see scripts/gasless-setup.mjs). The sponsor's policy
 * should in turn be limited to this registry's `anchorBatch`, so the sponsorship cannot be used for
 * anything else.
 */

/** The slice of a viem bundler client this class uses, so tests need no network. */
export interface UserOpSender {
  account: { address: Address };
  sendUserOperation(args: { calls: readonly { to: Address; data: Hex }[] }): Promise<Hex>;
  waitForUserOperationReceipt(args: { hash: Hex }): Promise<{ success: boolean; reason?: string; receipt: { transactionHash: Hex; blockNumber: bigint } }>;
}

export interface GaslessAnchorerOptions {
  publicClient: PublicClient;
  bundlerClient: UserOpSender;
  address: Address;
}

export class GaslessAnchorer {
  private readonly publicClient: PublicClient;
  private readonly bundlerClient: UserOpSender;
  private readonly address: Address;

  constructor({ publicClient, bundlerClient, address }: GaslessAnchorerOptions) {
    this.publicClient = publicClient;
    this.bundlerClient = bundlerClient;
    this.address = address;
  }

  /** The address that appears as `anchoredBy` on chain; the registry must have allowed it. */
  get anchorerAddress(): Address {
    return this.bundlerClient.account.address;
  }

  async anchorBatch(decisionHashes: readonly DecisionHash[], configHash: Hex): Promise<AnchoredBatch> {
    const tree = buildMerkleTree(decisionHashes);

    const verifier = new MonadVerifier({ publicClient: this.publicClient, address: this.address });
    if (await verifier.isAnchored(tree.root)) throw new Error(`batch root ${tree.root} is already anchored`);

    const data = encodeFunctionData({
      abi: DECISION_REGISTRY_ABI,
      functionName: "anchorBatch",
      args: [tree.root, configHash, decisionHashes.length],
    });

    const userOpHash = await this.bundlerClient.sendUserOperation({ calls: [{ to: this.address, data }] });
    const receipt = await this.bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
    if (!receipt.success) throw new Error(`user operation ${userOpHash} reverted${receipt.reason ? `: ${receipt.reason}` : ""}`);

    return {
      root: tree.root,
      txHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber,
      decisionCount: decisionHashes.length,
      proofs: decisionHashes.map((_, i) => proofFor(tree, i)),
    };
  }
}

export interface CreateGaslessAnchorerOptions {
  chain: Chain;
  /** Bundler + paymaster endpoint (e.g. Alchemy's `https://monad-testnet.g.alchemy.com/v2/<key>`). Contains a secret; never log it. */
  bundlerUrl: string;
  /** Plain RPC for reads; defaults to the chain's public RPC. */
  rpcUrl?: string;
  /** Key of the account that owns the smart account. It signs UserOperations and never pays gas. */
  signer: LocalAccount;
  /** The sponsor's gas policy id. */
  policyId: string;
  registry: Address;
}

/** Builds the smart account, bundler and paymaster clients and wraps them. */
export async function createGaslessAnchorer(o: CreateGaslessAnchorerOptions): Promise<GaslessAnchorer> {
  const publicClient = createPublicClient({ chain: o.chain, transport: http(o.rpcUrl) });
  const account = await toCoinbaseSmartAccount({ client: publicClient, owners: [o.signer], version: "1.1" });
  const paymaster = createPaymasterClient({ transport: http(o.bundlerUrl) });
  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: http(o.bundlerUrl),
    paymaster,
    paymasterContext: { policyId: o.policyId },
  });
  return new GaslessAnchorer({ publicClient: publicClient as PublicClient, bundlerClient: bundlerClient as unknown as UserOpSender, address: o.registry });
}

/** The smart account address a signer key controls, without sending anything. Needs only a read RPC. */
export async function smartAccountAddress(chain: Chain, signer: LocalAccount, rpcUrl?: string): Promise<Address> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return (await toCoinbaseSmartAccount({ client, owners: [signer], version: "1.1" })).address;
}
