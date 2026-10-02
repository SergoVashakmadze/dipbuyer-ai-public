# DipBuyer on Chainlink CRE: scheduled decision anchoring

A CRE workflow (`anchor/main.ts`) that, on a cron trigger, fetches decisions from the public DipBuyer API for a fixed `asOf`
(midnight UTC), hashes each with the repo's canonical JSON + keccak recipe, builds the Merkle root, and writes a signed report
through the Chainlink forwarder to `CreAnchorReceiver`, which anchors it on the `DecisionRegistry` (Monad testnet).
Anyone can then check a decision at https://dipbuyer.ai/verify/monad. It reuses `packages/chain-monad/src/{canonical,merkle}.ts`,
so proofs built from a CRE root verify unchanged.

Why CRE: the batch is built by the decentralised workflow (HTTP fetch with identical-response consensus, then a DON-signed report),
not by one machine holding an anchoring key.

## Status (2026-10-02)
- Simulation works: 5 real decisions fetched, root built, report produced (no broadcast).
- Broadcast run done: receiver `0x79cf4f8c9dcafe4cfe21c85c494acd5e4d0c9ab6` (mock forwarder), anchored root `0x4d548a4d…3903` via tx `0xc0d62aae…badaf`; listed on /verify/monad (`scripts/export-cre-batch.mjs`).
- Not yet done: deploy the workflow itself (needs CRE deployment access, `cre account access`) and switch the receiver to the real forwarder.

## Tooling (not in git, not on PATH)
- `~/.cre/bin/cre` v1.35.0 (sha256 verified; v1.36.0 was inside the 24h cooling-off). `cre login` per machine.
- `~/.local/bun-1.4.2/bun` (sha256 verified): the CRE compiler needs bun for TypeScript workflows.
- `cd cre/anchor && npm ci --ignore-scripts` (own lockfile; outside the pnpm workspace).

## Run
```
cd cre
printf 'CRE_ETH_PRIVATE_KEY=0x<throwaway key>\n' > .env && chmod 600 .env     # git-ignored; needed even for a dry simulation
PATH=$HOME/.local/bun-1.4.2:$PATH ~/.cre/bin/cre workflow simulate anchor --non-interactive --trigger-index 0 -T staging-settings
```
Add `--broadcast` to send the report for real (needs a deployed receiver in `anchor/config.staging.json`, a funded key in `.env`).

## On-chain setup (owner transactions)
Forwarders for monad-testnet (from `cre workflow supported-chains`): mock (simulation) `0xB9F79d863261869B234c481D1f9A7af84AeAd192`, real `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`.
```
cd packages/chain-monad && pnpm build
MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 \
CRE_FORWARDER=0xB9F79d863261869B234c481D1f9A7af84AeAd192 node scripts/deploy-cre-receiver.mjs --send
```
Then put the printed receiver address in `anchor/config.staging.json`. For production set `CRE_WORKFLOW_OWNER` (else any workflow owner is accepted) and use the real forwarder (`setForwarder`).
