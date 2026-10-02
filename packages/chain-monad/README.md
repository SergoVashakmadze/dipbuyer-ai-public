# @dipbuyer/chain-monad

Merkle-batched decision anchoring on Monad.

## Why

`@dipbuyer/chain` anchors one decision per Algorand transaction. That is fine for a handful of
decisions and impractical for a real run: a single rebalance screens ~500 companies, and the
ten-year backtest dump holds ~53,000 decision records.

This package anchors a whole run as **one Merkle root**. Any individual decision is still provable
against it with a ~9-hash inclusion proof, verifiable by anyone, with no server and no trust in us.

## What goes on chain

One 32-byte root per run, plus the hash of the strategy config that produced it, plus a count.
Nothing else. No company data, no holdings, no personal data. The decision records stay off chain;
the chain proves only that a set of decisions existed, unchanged, at a given block, under a named
version of the rules. It proves nothing about whether the decisions were any good.

## Layout

| Path | What |
|---|---|
| `src/merkle.ts` | Tree build, proof generation, verification. OpenZeppelin `MerkleProof`-compatible. |
| `contracts/DecisionRegistry.sol` | Anchors roots; verifies inclusion on chain. |

Leaves are double-hashed and sibling pairs sorted, so proofs carry no direction bits and no internal
node can be passed off as a leaf. `merkle.test.ts` asserts the TypeScript and Solidity encodings are
byte-identical — if they ever drifted, valid proofs would be rejected on chain while passing locally.

## Contract tests (Foundry)

`test/DecisionRegistry.t.sol`: 15 tests, three of them fuzzed (512 runs each). They cover deployment,
anchoring and its reverts, access control, and verification, against an independent Solidity
reference of the OpenZeppelin Merkle algorithm rather than the TypeScript builder. One test replays a
real decision from the anchored v0.4.0 batch with its TypeScript-produced proof against the live root,
so the two encodings cannot drift. Deliberately breaking the contract (pair order, the re-anchor
check, the anchorer check) fails the suite each time.

```sh
pnpm --filter @dipbuyer/chain-monad test:sol    # needs forge on PATH (tested with 1.8.3)
```

`foundry.toml` sets `network = "monad"` (official Foundry >= 1.8, no fork needed), so the tests run under
Monad's gas model and limits rather than Ethereum's. `forge build` with these settings reproduces the deployed runtime bytecode exactly,
apart from the trailing metadata hash.

Re-verify with forge (no API key needed):

```sh
forge verify-contract 0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 contracts/DecisionRegistry.sol:DecisionRegistry \
  --chain 10143 --verifier sourcify --verifier-url "https://sourcify-api-monad.blockvision.org/"
```

## Deploying

The contract is compiled ahead of time into `src/artifacts/DecisionRegistry.json`, so anchoring,
verifying and the tests need no Solidity toolchain. Only changing the contract does:

```sh
pnpm --filter @dipbuyer/chain-monad compile     # rewrites the committed artifact
```

Deploying needs a funded key. It is read from a file, never an argument or an inline env value, so
it cannot end up in shell history or a process listing, and it is never printed:

```sh
MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key \
  pnpm --filter @dipbuyer/chain-monad deploy    # MONAD_NETWORK=mainnet for chain 143
```

Chain definitions come from `viem/chains` (`monadTestnet` = 10143, `monad` = 143) rather than being
hardcoded here.

## Deployed

| | |
|---|---|
| Network | Monad Testnet (chain id 10143) |
| DecisionRegistry | `0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121` |
| Deploy tx | `0xe9b8221ffc2b776e06c6df5317ff958b04492397e589f2550d07abc2e6f981e0` |
| Gas | 534,375 |
| Source | Verified on Sourcify (runtime `match`, 2026-10-02): [lookup](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121) |

## Gasless anchoring (ERC-4337 paymaster)

The anchoring account never needs MON: the batch root goes to the registry as a UserOperation whose
gas Alchemy's Gas Manager sponsors (`src/gasless.ts`, Coinbase Smart Wallet v1.1 on EntryPoint v0.6;
both factory and EntryPoint are deployed on Monad testnet). The registry still only accepts allowlisted
anchorers, so the smart account is allowed once by the owner, and the sponsor policy should be limited
to this registry's `anchorBatch`.

```sh
# 1. a fresh signer key (holds nothing, only signs UserOperations)
(umask 077; mkdir -p ~/.dipbuyer; printf '0x%s\n' "$(openssl rand -hex 32)" > ~/.dipbuyer/monad-anchor-signer.key)

# 2. in the Alchemy dashboard: an app on Monad Testnet (API key -> ~/.dipbuyer/alchemy-api-key, mode 600),
#    and a Gas Manager policy for Monad Testnet restricted to the registry address. Note its Policy ID.

# 3. print the smart account address, then have the registry owner allow it (one ordinary tx, owner pays)
export MONAD_ANCHOR_SIGNER_KEY_FILE=~/.dipbuyer/monad-anchor-signer.key MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121
node scripts/gasless-setup.mjs
MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key node scripts/gasless-setup.mjs --allow

# 4. anchor with sponsored gas
ALCHEMY_API_KEY_FILE=~/.dipbuyer/alchemy-api-key ALCHEMY_GAS_POLICY_ID=<policy id> \
  node scripts/anchor-run.mjs <run-dump.json>
```

Alchemy policy type matters: create an **Onchain Paymaster** policy (Gas Sponsorship > New policy), not the
"Recommended" Gas Sponsorship (EVM) / BSO type. The BSO type is refused on the standard ERC-7677
`pm_getPaymasterData` call this code uses (`Unsupported Policy Type: BUNDLER_SPONSORSHIP`). Restrict the policy's
Access control allowlist to the smart account address that `gasless-setup.mjs` prints.

Status: verified end to end on Monad testnet (2026-10-02). An 8-decision smoke batch was anchored with sponsored gas
in tx `0x571f24e1befd611cb84e0acd9fdac7476f5ba791dbf8a3490987787c93a96718`: the smart account held 0 MON before and
after, `anchoredBy` is the smart account, and the bundler sent it through EntryPoint v0.6. Unit tests (5) use a
stubbed bundler.

## Anchoring a real run

```sh
MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key \
MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 \
  node scripts/anchor-run.mjs ~/dipbuyer-runs/baseline-v040.json
```

The v0.4.0 baseline backtest — **53,384 real decisions over 2016-2025** — anchored as a single
transaction, then one decision proved against it:

```
root   0x9b361f4620dda3d51aa6c3806928e52a981970c0740594bde912d8e5f3e6e911
tx     0xdb6f1f19d37f37428996492332f92eab12aec7982ac9abf8ba4bdaf1d799443f
depth  16

proving one decision: NWL on 2019-05-19 (avoid)
  proof is 16 hashes for a batch of 53,384
  locally  true
  on chain true
  tampered copy rejected: true
```

Sixteen hashes to prove one decision out of fifty-three thousand, against a chain that holds a
single 32-byte root. That ratio is the whole argument for doing this per run rather than per
decision.

## Status

- Merkle core, contract, anchorer, verifier: written, tested (22 tests), deployed, and exercised
  against a real backtest run.
- Public verify page: `/verify/monad` in `apps/web`. Hashes a decision in the browser, replays its
  proof, and reads the registry over a public Monad RPC; DipBuyer's API is never called. It ships four
  real decisions per anchored batch, listed in `apps/web/public/monad-batches.json`. The page checks every
  listed root against the registry on load (status, size and date come from the chain, not the file).
  After anchoring a new run, add it with `scripts/export-samples.mjs <dump> <root> <tx> <registry> <out> "<label>"`,
  which refuses to write unless the rebuilt root equals the anchored one.
- Next: anchor live rebalance runs (not just the backtest) and link each decision page to its proof.
