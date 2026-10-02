"use client";

import { EconomicCalendar, EtfHeatmap, MarketMovers, MarketOverview, MarketScreener, SectorPerformance, StockHeatmap } from "../../components/tradingview";
import { TickerSearch } from "../../components/research-ui";

/** Whole-market context from TradingView: where today's dips are, before drilling into a name. */
export default function MarketsPage() {
  return (
    <div>
      <h1>Markets</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        Where the dips are across the market today. Find a name, then open its research page for the Lynch verdict and the
        evidence behind it.
      </p>
      <TickerSearch />

      <div className="two-col" style={{ marginTop: 16 }}>
        <div>
          <h2>Market overview</h2>
          <p className="muted small">
            The &quot;Value vs growth&quot; tab is the comparison behind DipBuyer&apos;s research: cap-weighted vs equal-weighted, value vs growth.
          </p>
          <div className="card flush">
            <MarketOverview />
          </div>
        </div>
        <div>
          <h2>Sectors today</h2>
          <p className="muted small">S&amp;P 500 sector ETFs. A whole sector falling is a different dip from one company falling.</p>
          <div className="card flush">
            <SectorPerformance />
          </div>
        </div>
      </div>

      <h2>S&amp;P 500 heatmap</h2>
      <div className="card flush">
        <StockHeatmap />
      </div>

      <div className="two-col" style={{ marginTop: 16 }}>
        <div>
          <h2>Market movers</h2>
          <div className="card flush">
            <MarketMovers />
          </div>
        </div>
        <div>
          <h2>Economic calendar</h2>
          <div className="card flush">
            <EconomicCalendar />
          </div>
        </div>
      </div>

      <h2>ETF heatmap</h2>
      <p className="muted small">US ETFs by asset class, sized by today&apos;s trading volume (change the size and colour metrics in the widget&apos;s toolbar). Leveraged ETFs trade heavily, so they look bigger than their assets.</p>
      <div className="card flush">
        <EtfHeatmap />
      </div>

      <h2>Full US market screener</h2>
      <p className="muted small">TradingView&apos;s screener, opened on its undervalued preset. Not DipBuyer&apos;s methodology.</p>
      <div className="card flush">
        <MarketScreener />
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>Market widgets by TradingView.</p>
    </div>
  );
}
