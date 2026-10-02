# DipBuyer indexer (Envio HyperIndex)

Indexes the `DecisionRegistry` (`0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121`, Monad testnet, chain 10143) from its deploy block:
`BatchAnchored` -> `Batch`, `AnchorerSet` -> `Anchorer` (see `schema.graphql`). It exists because public Monad RPCs cap
`eth_getLogs` at about 100 blocks, which is why `/verify/monad` currently reads a hand-committed manifest
(`apps/web/public/monad-batches.json`). With this indexer the batch list comes from one GraphQL query.

Not part of the pnpm workspace (own lockfile). Install with `pnpm install --ignore-workspace --ignore-scripts`.

## Run locally
```
pnpm install --ignore-workspace --ignore-scripts
echo "ENVIO_API_TOKEN=<free token from https://envio.dev/app/api-tokens>" > .env   # HyperSync needs it
pnpm exec envio dev          # Docker: Postgres + Hasura; GraphQL at http://localhost:8080 (admin secret: testing)
```
Query: `{ Batch(order_by:{anchoredAt:desc}) { id decisionCount anchoredBy anchoredAt blockNumber txHash configHash } }`

Without a token you can test by adding to the chain in `config.yaml` (and running `pnpm exec envio stop` after config changes):
```
    rpc:
      - url: https://testnet-rpc.monad.xyz
        for: sync
```
Verified 2026-10-02 this way: the one real batch came back with the same root, tx hash (`0xdb6f1f19...`) and count (53,384) as the manifest.

## Hosting (owner step)
Deploy through Envio's hosted service (envio.dev, connect this repo, root dir `indexer`), then point `/verify/monad`
at its GraphQL URL and keep `monad-batches.json` only for the sample decisions.
