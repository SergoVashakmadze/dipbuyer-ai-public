"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "./theme";

/**
 * One loader for every TradingView embed (DESIGN.md §6: price charts via TradingView widgets).
 * Each widget is a script tag whose text is its JSON config; TradingView swaps it for an iframe.
 * Ad and tracker blockers often drop the script silently, with no error event and no request,
 * so the fallback is keyed on "no iframe appeared in time", not on onerror.
 *
 * Catalogue: https://www.tradingview.com/widget-docs/widgets/
 */

const EMBED_BASE = "https://s3.tradingview.com/external-embedding/embed-widget-";
const BLOCKED_AFTER_MS = 8000;

type WidgetName =
  | "advanced-chart"
  | "technical-analysis"
  | "financials"
  | "symbol-profile"
  | "stock-heatmap"
  | "screener"
  | "timeline"
  | "events"
  | "hotlists"
  | "ticker-tape"
  | "market-overview"
  | "market-quotes"
  | "etf-heatmap";

interface EmbedProps {
  widget: WidgetName;
  config: Record<string, unknown>;
  height: number;
  fallbackHref: string;
}

export function TradingViewEmbed({ widget, config, height, fallbackHref }: EmbedProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  const configKey = JSON.stringify(config);
  const { theme } = useTheme();

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    setBlocked(false);
    container.innerHTML = "";
    const target = document.createElement("div");
    target.className = "tradingview-widget-container__widget";
    target.style.height = "100%";
    container.appendChild(target);
    const script = document.createElement("script");
    script.src = `${EMBED_BASE}${widget}.js`;
    script.async = true;
    // Follows the app theme; the widget is rebuilt when it changes. Most widgets read colorTheme,
    // the advanced chart reads theme. Read the live attribute rather than the hook's state: state
    // starts "light" on the first client render, so on a dark page the widget was built light
    // (grey labels on white) and only a manual toggle ever corrected it.
    const active = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    script.text = JSON.stringify({ colorTheme: active, theme: active, isTransparent: true, locale: "en", ...JSON.parse(configKey) });
    container.appendChild(script);
    const timer = window.setTimeout(() => {
      if (!container.querySelector("iframe")) setBlocked(true);
    }, BLOCKED_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      container.innerHTML = "";
    };
  }, [widget, configKey, theme]);

  return (
    <div className="tv-frame" style={{ height }}>
      <div ref={ref} className="tradingview-widget-container" style={{ height: "100%" }} />
      {blocked && (
        <div className="tv-blocked" role="status">
          <p>This TradingView widget did not load. An ad or tracker blocker is the usual cause.</p>
          <a href={fallbackHref} target="_blank" rel="noopener noreferrer">
            Open on TradingView ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** TradingView accepts bare US tickers and resolves the primary listing itself. */
const symbolPage = (symbol: string) => `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;

export function AdvancedChart({ symbol, height = 520 }: { symbol: string; height?: number }) {
  return (
    <TradingViewEmbed
      widget="advanced-chart"
      height={height}
      fallbackHref={symbolPage(symbol)}
      config={{
        symbol,
        autosize: true,
        interval: "D",
        range: "12M",
        timezone: "Etc/UTC",
        style: "1",
        allow_symbol_change: false,
        withdateranges: true,
        studies: ["STD;SMA"],
        support_host: "https://www.tradingview.com",
      }}
    />
  );
}

export function TechnicalAnalysis({ symbol, height = 440 }: { symbol: string; height?: number }) {
  return (
    <TradingViewEmbed
      widget="technical-analysis"
      height={height}
      fallbackHref={`${symbolPage(symbol)}technicals/`}
      config={{ symbol, interval: "1D", width: "100%", height: "100%", showIntervalTabs: true, displayMode: "single" }}
    />
  );
}

export function FinancialsWidget({ symbol, height = 600 }: { symbol: string; height?: number }) {
  return (
    <TradingViewEmbed
      widget="financials"
      height={height}
      fallbackHref={`${symbolPage(symbol)}financials-overview/`}
      config={{ symbol, width: "100%", height: "100%", displayMode: "regular" }}
    />
  );
}

export function CompanyProfile({ symbol, height = 600 }: { symbol: string; height?: number }) {
  return (
    <TradingViewEmbed
      widget="symbol-profile"
      height={height}
      fallbackHref={symbolPage(symbol)}
      config={{ symbol, width: "100%", height: "100%" }}
    />
  );
}

export function SymbolNews({ symbol, height = 440 }: { symbol: string; height?: number }) {
  return (
    <TradingViewEmbed
      widget="timeline"
      height={height}
      fallbackHref={`${symbolPage(symbol)}news/`}
      config={{ feedMode: "symbol", symbol, displayMode: "regular", width: "100%", height: "100%" }}
    />
  );
}

export function StockHeatmap({ height = 600 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="stock-heatmap"
      height={height}
      fallbackHref="https://www.tradingview.com/heatmap/stock/"
      config={{
        dataSource: "SPX500",
        grouping: "sector",
        blockSize: "market_cap_basic",
        blockColor: "change",
        hasTopBar: true,
        isDataSetEnabled: true,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        width: "100%",
        height: "100%",
      }}
    />
  );
}

export function MarketScreener({ height = 680 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="screener"
      height={height}
      fallbackHref="https://www.tradingview.com/screener/"
      config={{ market: "america", defaultColumn: "valuation", defaultScreen: "undervalued", showToolbar: true, width: "100%", height: "100%" }}
    />
  );
}

export function MarketMovers({ height = 520 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="hotlists"
      height={height}
      fallbackHref="https://www.tradingview.com/markets/stocks-usa/market-movers-losers/"
      config={{ exchange: "US", dateRange: "12M", showChart: true, width: "100%", height: "100%" }}
    />
  );
}

export function EconomicCalendar({ height = 520 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="events"
      height={height}
      fallbackHref="https://www.tradingview.com/economic-calendar/"
      config={{ importanceFilter: "0,1", countryFilter: "us", width: "100%", height: "100%" }}
    />
  );
}

/**
 * Market ticker tape across the top of the app. Indices first, then the mega caps the Lynch engine
 * screens most often. Single-line `regular` mode rather than the old site's scrolling billboard —
 * and unlike `compact`, it renders the company name in the primary text colour, which stays
 * readable on the dark theme.
 */
export function TickerTape() {
  return (
    <TradingViewEmbed
      widget="ticker-tape"
      height={46}
      fallbackHref="https://www.tradingview.com/markets/"
      config={{
        symbols: [
          { proName: "AMEX:SPY", title: "S&P 500" },
          { proName: "NASDAQ:QQQ", title: "Nasdaq 100" },
          { proName: "AMEX:RSP", title: "S&P equal weight" },
          { proName: "NASDAQ:AAPL", title: "Apple" },
          { proName: "NASDAQ:MSFT", title: "Microsoft" },
          { proName: "NASDAQ:NVDA", title: "Nvidia" },
          { proName: "NYSE:JPM", title: "JPMorgan" },
          { proName: "NYSE:KO", title: "Coca-Cola" },
        ],
        showSymbolLogo: true,
        displayMode: "regular",
      }}
    />
  );
}

/** Market-wide Top Stories (the news timeline in market mode). */
export function MarketNews({ height = 560 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="timeline"
      height={height}
      fallbackHref="https://www.tradingview.com/news/"
      config={{ feedMode: "market", market: "stock", displayMode: "regular", width: "100%", height: "100%" }}
    />
  );
}

const OVERVIEW_TABS = [
  {
    title: "Indices",
    symbols: [
      { s: "AMEX:SPY", d: "S&P 500" },
      { s: "NASDAQ:QQQ", d: "Nasdaq 100" },
      { s: "AMEX:DIA", d: "Dow Jones" },
      { s: "AMEX:IWM", d: "Russell 2000" },
    ],
  },
  {
    // The comparison DipBuyer's own research turns on: cap-weighted vs equal-weighted, value vs growth.
    title: "Value vs growth",
    symbols: [
      { s: "AMEX:SPY", d: "S&P 500 (cap weight)" },
      { s: "AMEX:RSP", d: "S&P 500 equal weight" },
      { s: "AMEX:IVE", d: "S&P 500 Value" },
      { s: "AMEX:IVW", d: "S&P 500 Growth" },
      { s: "AMEX:VTV", d: "Vanguard Value" },
    ],
  },
  {
    title: "Rates & dollar",
    symbols: [
      { s: "NASDAQ:SHY", d: "1-3y Treasuries" },
      { s: "NASDAQ:TLT", d: "20y+ Treasuries" },
      { s: "AMEX:UUP", d: "US dollar" },
      { s: "AMEX:GLD", d: "Gold" },
    ],
  },
];

/** Tabbed index overview with a 12-month chart per tab. */
export function MarketOverview({ height = 520 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="market-overview"
      height={height}
      fallbackHref="https://www.tradingview.com/markets/indices/"
      config={{
        tabs: OVERVIEW_TABS,
        dateRange: "12M",
        showChart: true,
        showSymbolLogo: true,
        showFloatingTooltip: true,
        width: "100%",
        height: "100%",
      }}
    />
  );
}

/** S&P sector ETFs as a quotes table: which sectors are dipping today. */
export function SectorPerformance({ height = 480 }: { height?: number }) {
  const sectors: Array<[string, string]> = [
    ["AMEX:XLK", "Technology"],
    ["AMEX:XLF", "Financials"],
    ["AMEX:XLV", "Health care"],
    ["AMEX:XLY", "Consumer discretionary"],
    ["AMEX:XLP", "Consumer staples"],
    ["AMEX:XLI", "Industrials"],
    ["AMEX:XLE", "Energy"],
    ["AMEX:XLU", "Utilities"],
    ["AMEX:XLB", "Materials"],
    ["AMEX:XLRE", "Real estate"],
    ["AMEX:XLC", "Communication services"],
  ];
  return (
    <TradingViewEmbed
      widget="market-quotes"
      height={height}
      fallbackHref="https://www.tradingview.com/markets/etfs/"
      config={{
        symbolsGroups: [{ name: "S&P 500 sectors", symbols: sectors.map(([name, displayName]) => ({ name, displayName })) }],
        showSymbolLogo: true,
        width: "100%",
        height: "100%",
      }}
    />
  );
}

/**
 * US ETF heatmap grouped by asset class. Sized by the widget's default (1-day trading volume): the
 * documented-looking "aum" and "market_cap_basic" keys were both ignored on 2026-09-18, and visitors
 * can switch the size metric in the widget's own toolbar.
 */
export function EtfHeatmap({ height = 560 }: { height?: number }) {
  return (
    <TradingViewEmbed
      widget="etf-heatmap"
      height={height}
      fallbackHref="https://www.tradingview.com/heatmap/etf/"
      config={{
        dataSource: "AllUSEtf",
        blockColor: "change",
        grouping: "asset_class",
        hasTopBar: true,
        isDataSetEnabled: true,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        width: "100%",
        height: "100%",
      }}
    />
  );
}
