/**
 * Financial news feeds, carried over from the IoMarkets.news aggregator.
 *
 * The important detail is WHY several of these point at news.google.com rather than the publisher.
 * Reuters retired its own RSS around 2020, and WSJ, Barron's, Benzinga, AP, Mining.com and Kitco
 * either 403 or 404 a plain feed request. Their dedicated Google News search feeds still return
 * those publishers' articles, so the alternative to this indirection is simply not carrying
 * Reuters — which is what happened to the older DipBuyer feed list, where six feeds including all
 * three Reuters ones were dead while the page still advertised "Reuters, Bloomberg, CNBC".
 *
 * The list is CURATED for business, markets, economy and market-relevant politics. Consumer
 * gadget sites, personal-finance tips, low-signal crypto churn and non-English regional feeds were
 * removed deliberately — they filled the page with kitchenware and pop-royalty stories.
 *
 * Every feed in this list was checked live before it was committed. If one starts failing the
 * aggregator drops it silently rather than failing the page, so re-run that check before trusting
 * the source count in any copy.
 */
export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  category: NewsCategory;
  /** 1 = wire services and majors, 3 = niche. Used to break ties when ranking. */
  priority: number;
}

export type NewsCategory =
  | "markets" | "business" | "economy" | "finance"
  | "technology" | "crypto" | "commodities" | "forex" | "global" | "politics";

export const NEWS_CATEGORIES: { id: NewsCategory | "all"; label: string }[] = [
  { id: "all", label: "All news" },
  { id: "markets", label: "Markets" },
  { id: "business", label: "Business" },
  { id: "economy", label: "Economy" },
  { id: "finance", label: "Finance" },
  { id: "technology", label: "Technology" },
  { id: "crypto", label: "Crypto" },
  { id: "commodities", label: "Commodities" },
  { id: "forex", label: "FX" },
  { id: "politics", label: "Politics" },
  { id: "global", label: "World" },
];

export const NEWS_FEEDS: NewsFeed[] = [
  { id: "bloomberg-markets", name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss", category: "markets", priority: 1 },
  { id: "dow-jones", name: "Dow Jones", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "markets", priority: 1 },
  { id: "ft-markets", name: "Financial Times Markets", url: "https://www.ft.com/rss/markets", category: "markets", priority: 1 },
  { id: "reuters-markets", name: "Reuters Markets", url: "https://news.google.com/rss/search?q=when:7d+site:reuters.com+markets&hl=en-US&gl=US&ceid=US:en", category: "markets", priority: 1 },
  { id: "wsj-markets", name: "Wall Street Journal Markets", url: "https://news.google.com/rss/search?q=when:7d+site:wsj.com+markets&hl=en-US&gl=US&ceid=US:en", category: "markets", priority: 1 },
  { id: "bnn-bloomberg", name: "BNN Bloomberg", url: "https://www.bnnbloomberg.ca/arc/outboundfeeds/rss/?outputType=xml", category: "markets", priority: 2 },
  { id: "barrons", name: "Barrons", url: "https://news.google.com/rss/search?q=when:7d+site:barrons.com&hl=en-US&gl=US&ceid=US:en", category: "markets", priority: 2 },
  { id: "cnbc-markets", name: "CNBC Markets", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", category: "markets", priority: 2 },
  { id: "investing-com", name: "Investing.com", url: "https://www.investing.com/rss/news.rss", category: "markets", priority: 2 },
  { id: "marketwatch", name: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories/", category: "markets", priority: 2 },
  { id: "marketwatch-markets", name: "MarketWatch Markets", url: "https://news.google.com/rss/search?q=when:7d+site:marketwatch.com&hl=en-US&gl=US&ceid=US:en", category: "markets", priority: 2 },
  { id: "ibd", name: "Investors Business Daily", url: "https://www.investors.com/feed/", category: "markets", priority: 3 },
  { id: "seeking-alpha", name: "Seeking Alpha", url: "https://seekingalpha.com/feed.xml", category: "markets", priority: 3 },
  { id: "ft-home", name: "Financial Times", url: "https://www.ft.com/rss/home", category: "business", priority: 1 },
  { id: "nyt-business", name: "NYT Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", category: "business", priority: 1 },
  { id: "reuters-business", name: "Reuters Business", url: "https://news.google.com/rss/search?q=when:7d+site:reuters.com+business&hl=en-US&gl=US&ceid=US:en", category: "business", priority: 1 },
  { id: "wsj-business", name: "Wall Street Journal Business", url: "https://news.google.com/rss/search?q=when:7d+site:wsj.com+business&hl=en-US&gl=US&ceid=US:en", category: "business", priority: 1 },
  { id: "ap-business", name: "AP Business", url: "https://news.google.com/rss/search?q=when:7d+site:apnews.com+business&hl=en-US&gl=US&ceid=US:en", category: "business", priority: 2 },
  { id: "bbc-business", name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", category: "business", priority: 2 },
  { id: "cnbc-top", name: "CNBC Top News", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", category: "business", priority: 2 },
  { id: "guardian-business", name: "Guardian Business", url: "https://www.theguardian.com/uk/business/rss", category: "business", priority: 2 },
  { id: "fed-reserve", name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", category: "economy", priority: 2 },
  { id: "economist", name: "The Economist", url: "https://www.economist.com/finance-and-economics/rss.xml", category: "economy", priority: 2 },
  { id: "nyt-economy", name: "NYT Economy", url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml", category: "economy", priority: 3 },
  { id: "yahoo-finance", name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", category: "finance", priority: 2 },
  { id: "reuters-tech", name: "Reuters Technology", url: "https://news.google.com/rss/search?q=when:7d+site:reuters.com+technology&hl=en-US&gl=US&ceid=US:en", category: "technology", priority: 1 },
  { id: "cnbc-tech", name: "CNBC Technology", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html", category: "technology", priority: 2 },
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "crypto", priority: 2 },
  { id: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml", category: "crypto", priority: 2 },
  { id: "kitco", name: "Kitco", url: "https://news.google.com/rss/search?q=when:7d+gold+OR+silver+OR+precious+metals+price&hl=en-US&gl=US&ceid=US:en", category: "commodities", priority: 3 },
  { id: "mining-com", name: "Mining.com", url: "https://news.google.com/rss/search?q=when:7d+site:mining.com&hl=en-US&gl=US&ceid=US:en", category: "commodities", priority: 3 },
  { id: "oilprice", name: "OilPrice.com", url: "https://oilprice.com/rss/main", category: "commodities", priority: 3 },
  { id: "investing-forex", name: "Investing.com Forex", url: "https://www.investing.com/rss/news_1.rss", category: "forex", priority: 3 },
  { id: "caixin-global", name: "Caixin Global", url: "https://news.google.com/rss/search?q=when:7d+site:caixinglobal.com&hl=en-US&gl=US&ceid=US:en", category: "global", priority: 1 },
  { id: "reuters-politics", name: "Reuters Politics", url: "https://news.google.com/rss/search?q=when:7d+site:reuters.com+politics&hl=en-US&gl=US&ceid=US:en", category: "politics", priority: 1 },
  { id: "reuters-world", name: "Reuters World", url: "https://news.google.com/rss/search?q=when:7d+site:reuters.com+world&hl=en-US&gl=US&ceid=US:en", category: "politics", priority: 1 },
  { id: "ap-politics", name: "AP Politics", url: "https://news.google.com/rss/search?q=when:7d+site:apnews.com+politics&hl=en-US&gl=US&ceid=US:en", category: "politics", priority: 1 },
  { id: "ft-world", name: "Financial Times World", url: "https://news.google.com/rss/search?q=when:7d+site:ft.com+world&hl=en-US&gl=US&ceid=US:en", category: "politics", priority: 1 },
  { id: "politico-economy", name: "Politico Economy", url: "https://news.google.com/rss/search?q=when:7d+site:politico.com+economy+OR+trade&hl=en-US&gl=US&ceid=US:en", category: "politics", priority: 2 },
  { id: "bbc-politics", name: "BBC Politics", url: "https://feeds.bbci.co.uk/news/politics/rss.xml", category: "politics", priority: 2 },
];
