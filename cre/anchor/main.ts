import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  getNetwork,
  handler,
  ok,
  prepareReportRequest,
  Runner,
  text,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";
// The same canonical-JSON and Merkle code the anchoring script and /verify/monad use, so a proof
// built from this workflow's root verifies in the browser unchanged.
import { hashDecision } from "../../packages/chain-monad/src/canonical";
import { buildMerkleTree } from "../../packages/chain-monad/src/merkle";

export type Config = {
  /** Cron schedule (6 fields, seconds first). */
  schedule: string;
  /** DipBuyer API base, e.g. https://api.dipbuyer.ai/api (public endpoint, no key). */
  apiBaseUrl: string;
  symbols: string[];
  /** Name of the strategy config version; its keccak256 is stored on chain as configHash. */
  configLabel: string;
  chainName: string;
  /** CreAnchorReceiver address. */
  receiver: string;
  gasLimit: string;
};

/**
 * Runs on every node. Fetches one decision as of a fixed instant and returns its hash. Every node must
 * get the same bytes for consensus, which holds because the endpoint is deterministic for a given asOf.
 */
const fetchDecisionHash = (sendRequester: HTTPSendRequester, url: string): string => {
  const res = sendRequester.sendRequest({ url, method: "GET" }).result();
  if (!ok(res)) throw new Error(`decision request failed: HTTP ${res.statusCode}`);
  const body = JSON.parse(text(res)) as { record?: unknown };
  if (!body.record) throw new Error("response has no decision record");
  return hashDecision(body.record);
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;

  // Midnight UTC of the trigger day: fixed for every node, and for every symbol in the batch.
  const now = runtime.now();
  const asOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const http = new cre.capabilities.HTTPClient();
  const hashes: Hex[] = cfg.symbols.map((symbol) => {
    const url = `${cfg.apiBaseUrl}/decisions/${encodeURIComponent(symbol)}?asOf=${encodeURIComponent(asOf)}`;
    return http.sendRequest(runtime, fetchDecisionHash, consensusIdenticalAggregation<string>())(url).result() as Hex;
  });

  const tree = buildMerkleTree(hashes);
  const configHash = keccak256(stringToBytes(cfg.configLabel));
  runtime.log(`asOf ${asOf}: ${hashes.length} decisions, root ${tree.root}`);

  // Report layout the receiver decodes: (bytes32 root, bytes32 configHash, uint32 decisionCount).
  const payload = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }],
    [tree.root, configHash, hashes.length],
  );
  const report = runtime.report(prepareReportRequest(payload)).result();

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${cfg.chainName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const written = evm
    .writeReport(runtime, { receiver: cfg.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();

  const tx = written.txHash ? bytesToHex(written.txHash) : "none";
  runtime.log(`report written, tx ${tx}`);
  return tree.root;
};

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
