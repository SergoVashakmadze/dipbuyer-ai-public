# Backtest methodology — biases, controls, and known limitations

> Its purpose is to state, in one place, what
> our backtest numbers do and do not establish — so that neither we nor a reader can quote a figure
> without its caveats. Every limitation below is disclosed deliberately; none is a TODO we forgot.

## Why this document exists

On 2026-07-19 five silent data bugs invalidated every backtest number the project had produced. A
sixth was found on 2026-07-20. All six shared one shape: **they returned something plausible
instead of raising, and every one passed the unit suite** — because the mocks encoded our
assumptions about each data source rather than its real behaviour, and so confirmed the bugs.

The lesson drives the whole method here: **a backtest number is not evidence until the ways it
could be wrong have been enumerated and independently checked.** Tests assert against real,
externally checkable facts (actual filing dates, actual index events, independently-priced SPY),
not against fixtures of our own invention.

## Bias controls

| Bias | Control | Status |
|---|---|---|
| Look-ahead (fundamentals) | Point-in-time cut on the real SEC `filed` date, not fiscal period end | ✅ exact via EDGAR |
| Look-ahead (prices) | Every price read is cut at the simulated clock, including from cache | ✅ tested |
| Survivorship | Point-in-time S&P 500 membership per rebalance date | ✅ `--point-in-time` |
| Delisting / phantom holdings | Positions that stop trading are exited, not carried at a stale mark | ✅ see below |
| Benchmark misreporting | `benchmarkRelativePct` is null when unpriceable, and warns on span mismatch | ✅ both tested |
| Frictions | Commission, slippage and half-spread applied on entry and exit | ✅ |
| Liquidity | Trailing ADV floor excludes names too thin to trade at size | ✅ |
| Data-source failure | Transport failures counted and surfaced separately from genuine absence | ✅ |

### Survivorship

A universe of companies that exist **today** is optimistic by construction: the strategy is never
given the chance to buy a name that later failed. SIVB, FRC, TWTR, ATVI and WBA are all absent from
such a list, and a dip-buying screen would plausibly have bought several on the way down.

`--point-in-time` screens actual index membership as of each rebalance date. Names that leave are
still screened while held (so they can be exited) but stop being buyable — buying a departed name
would mean buying it *because* we know it survived into today's list, which is look-ahead of the
worst kind.

Every result carries `universeSource`, so a number cannot be quoted without its bias status.

### Delisting treatment — a deliberate, disclosed approximation

When a held name stops trading, the position is **exited at the last observed close**.

- This models the **common** case well: most index departures are acquisitions or mergers, where
  holders are paid near market. ATVI holders received $95/share in cash from Microsoft.
- It is **optimistic in the bankruptcy tail**: SIVB and FRC holders received approximately nothing,
  but this method credits the last traded price (SIVB halted around $106).
- The alternative — writing every departure to zero — is *worse*, because it is badly wrong for the
  common case.

Distinguishing the two requires a corporate-actions data source we do not have. **This is the most
material known optimistic bias remaining in the results.** The run warns whenever the path fires.

Fixing it properly is the highest-value next step for anyone who needs these numbers to be
externally defensible.

## Price source

Prices come from **Alpaca** by default, or from **Polygon/Massive** with `BACKTEST_PRICE_SOURCE=polygon`.
Every result records `dataSource.marketData` (the adapter actually used) and, for Alpaca,
`dataSource.marketDataFeed` (`iex` or `sip`). Results from different sources or feeds are **not
directly comparable** — run `apps/api/scripts/compare-price-sources.mjs` over the same window first
and quote any gap alongside the numbers.

Both sources use two price series: `adjustment=all` for trading, marking and the SPY benchmark;
`raw` for valuation against as-filed EPS. They are aligned as follows:

| | Alpaca | Polygon/Massive |
|---|---|---|
| Split adjustment | vendor (`adjustment=split`) | vendor (`adjusted=true`, splits ONLY) |
| Dividend adjustment | vendor (`adjustment=all`; formula not published) | computed here: bars before each ex-date × `(1 − dividend / previous close)`, compounding, from `/stocks/v1/dividends` |
| Adjusted levels anchored to | the present | the present (all known later dividends) |
| Daily bar timestamp | `YYYY-MM-DDT05:00:00Z` / `04:00:00Z` (midnight ET) | converted to the same string |
| History limit | IEX 2021-01-04; SIP: see your Alpaca plan | plan-dependent: Basic 2y, Starter 5y, Developer 10y, Advanced all |

Adjusted **levels** embed corporate actions after the clock on both sources; adjusted **returns**
do not, so this is not look-ahead for performance. The $1 price floor and ADV gate see those levels
on both sources alike.

Metric added with this: `avgCashPct`, the mean cash share of equity across clocks. Cash earns
nothing in the simulator, so a high value is a structural drag against a fully-invested benchmark
and must be ruled out before attributing underperformance to stock selection.

## What the numbers still do NOT establish

1. **One window is one regime.** A single 2023–2025 run says nothing about whether the strategy
   generalises. Thresholds must be calibrated on one window and validated on another; tuning until
   the backtest improves is curve-fitting and cannot be defended to an investor or the FCA.
2. **US filers only.** SEC EDGAR covers US registrants, so a UK leg is untested.
3. **Missing criteria.** EDGAR exposes no institutional ownership or insider net buying (13F and
   Form 4 are separate datasets). The scorer omits absent criteria and renormalises, so verdicts
   stay valid on ~10% fewer weights — but they are not the full method.
4. **Paper execution.** Fills are modelled, not real. No market impact beyond a fixed spread and
   slippage assumption, and no partial fills.
5. **Index membership is not the Lynch universe.** Screening the S&P 500 screens the 500 most
   institutionally-covered companies in the world, which is close to the opposite of Lynch's
   premise of finding names before the market does. A SEC filer universe would be philosophically
   closer and is public domain; it is deferred, not rejected.

## Reproducibility

- Universe membership is **vendored and hash-pinned** (`packages/data/vendor/`), never fetched at
  run time — a file that changes under us cannot support a reproducible number. Refresh is a
  deliberate act: re-download, re-verify, re-commit, re-run.
- A window extending past the vendored snapshot is **refused**, because beyond it the file silently
  returns today's members — reintroducing the exact bias the control removes.
- Results carry `dataSource` (including price source and Alpaca feed), `universeSource`,
  `exactFilingDates` and `reportingLagDays`.

## Before trusting any number

1. Run `node apps/api/scripts/check-data-integrity.mjs` — nine invariants against LIVE APIs, one
   per historical bug. It is deliberately not in `pnpm test` (network-bound and rate-limited), and
   it found one of the six bugs on its first run.
2. Check `benchmarkRelativePct` is not equal to `totalReturnPct` and is not null.
3. Check `universeSource` before quoting the figure anywhere.

## Licence constraint on the universe data

S&P Dow Jones Indices asserts proprietary rights over index constituent data. The vendored file is
a **backtest input only** — never an API response, never a user-facing feature — and product copy
describes the universe generically. Full provenance and reasoning in `packages/data/vendor/README.md`.
