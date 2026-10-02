# Vendored data

## `sp500-membership.csv` is NOT included in this repository

The backtester reads point-in-time S&P 500 membership (`ticker,start_date,end_date`) from
`packages/data/vendor/sp500-membership.csv`. That file is index-constituent data whose underlying rights
are not ours to redistribute, so it is not published here. To run the backtest, obtain it yourself:

| | |
|---|---|
| Source | https://github.com/fja05680/sp500, file `sp500_ticker_start_end.csv` (repo licence: MIT) |
| Version used | retrieved 2026-07-20, 1,259 intervals, 503 current members |
| sha256 | `39c488ebd6ce6838599e54751adbe8c8e4b68d5801dd77d29b6d137dd77388ac` |

Check the licence of the underlying data for your own use. Tests that need the file skip themselves when it
is absent. The data is a backtest **input** only; it is never returned by the API or rendered in the web app.

## `fred-tb3ms.csv`

3-Month Treasury Bill secondary market rate, monthly average, percent (FRED series `TB3MS`),
https://fred.stlouisfed.org/series/TB3MS, retrieved 2026-09-16. US government data, public domain. Used only
as the backtest cash yield (`BACKTEST_CASH_POLICY=tbill`).

## `cik-overrides.json`

Ticker -> SEC CIK for index members absent from SEC's current `company_tickers.json` (delisted, acquired,
renamed), built by `apps/api/scripts/build-cik-overrides.mjs`. A CIK is a public SEC identifier. Backtest
input only (`BACKTEST_CIK_OVERRIDES=1`).
