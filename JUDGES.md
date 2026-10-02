# For judges: verify it yourself in five minutes

DipBuyer AI anchors a Merkle root of its decisions on Monad **testnet**. Everything below is read-only; nothing needs a key or a wallet.

## 1. In the browser (1 minute)
Open https://dipbuyer.ai/verify/monad.
- Three batches are listed (the list comes from an Envio HyperIndex indexer; each row is re-read from the registry on chain).
- Pick a decision from the **Chainlink CRE run** and press **Verify**. The page hashes the record in your browser, replays its inclusion proof, and asks the registry whether that root was anchored. DipBuyer's servers are not contacted.
- Press **Alter the verdict, then verify again**: the same check now fails.

## 2. Reproduce the Chainlink batch from scratch (2 minutes)
```
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @dipbuyer/chain-monad build
node packages/chain-monad/scripts/verify-cre-batch.mjs
```
It refetches five decisions from the public API, rebuilds the Merkle root locally and compares it with the root the registry holds. Expected: `roots match: YES` and `anchored on Monad: YES, 5 decisions ... by 0x79cf4f8c...` (the Chainlink receiver contract).

## 3. The contracts and tests (1 minute)
`packages/chain-monad` has `DecisionRegistry` (`0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121`, source verified on Sourcify) and `CreAnchorReceiver` (`0x79cf4f8c9dcafe4cfe21c85c494acd5e4d0c9ab6`). With Foundry 1.8+: `cd packages/chain-monad && forge test` runs 23 tests.

## 4. Where each bounty lives
| Bounty | Where |
|---|---|
| Best Use of Envio | `indexer/` (hosted HyperIndex indexer, drives the batch list above) |
| Best Projects using Alchemy | `packages/chain-monad/src/gasless.ts` (ERC-4337 + Alchemy Gas Manager); tx `0x571f24e1befd611cb84e0acd9fdac7476f5ba791dbf8a3490987787c93a96718` |
| Best workflow with CRE | `cre/` (workflow, simulated with `--broadcast`) + `CreAnchorReceiver.sol`; tx `0xc0d62aae3a9626bfdd1dcb7a1e3833c8960b5ddd1e567bd5c42fc79560abadaf` |
| Track: Trust, Identity & AI Infrastructure | provenance above, plus ERC-8004 agentId **1978** in the canonical Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

## What was built when, and what it does not prove
The Peter Lynch rules engine, backtest, web app and Algorand anchoring existed before the hackathon; the Monad registry, anchoring, gasless path, CRE workflow, indexer, ERC-8004 registration and `/verify/monad` were built from 17 Sep 2026. The proof shows a decision existed unchanged under a named rule version; it does not show the decision was good or that the inputs were real market data. The CRE workflow is simulated, not deployed. All on Monad testnet.
