import { indexer } from "envio";

indexer.onEvent({ contract: "DecisionRegistry", event: "BatchAnchored" }, async ({ event, context }) => {
  context.Batch.set({
    id: event.params.root,
    root: event.params.root,
    configHash: event.params.configHash,
    decisionCount: Number(event.params.decisionCount),
    anchoredBy: event.params.anchoredBy,
    anchoredAt: Number(event.params.anchoredAt),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "DecisionRegistry", event: "AnchorerSet" }, async ({ event, context }) => {
  context.Anchorer.set({ id: event.params.account, allowed: event.params.allowed, updatedAtBlock: event.block.number });
});
