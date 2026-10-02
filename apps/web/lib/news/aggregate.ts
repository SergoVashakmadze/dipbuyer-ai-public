import { NEWS_FEEDS, type NewsCategory, type NewsFeed } from "./feeds";

/**
 * Stateless news aggregation: fetch the feeds on request, merge, de-duplicate, rank, return.
 *
 * Deliberately no database and no scheduled job. A cron pulling 51 feeds every 15 minutes runs
 * ~2,900 times a month whether or not anyone is reading, and on a private repo that is billed CI
 * time. Fetching on request behind a CDN cache header costs nothing when nobody is looking, and
 * the freshness difference for financial headlines is a couple of minutes.
 */

export interface Article {
  id: string;
  title: string;
  url: string;
  summary: string;
  source: string;
  sourceId: string;
  category: NewsCategory;
  publishedAt: string;
  imageUrl: string | null;
  /** Tickers mentioned, upper-case, best effort. */
  symbols: string[];
  sentiment: "bullish" | "bearish" | "neutral";
}

const FETCH_TIMEOUT_MS = 6000;
const MAX_PER_FEED = 12;
const MAX_AGE_DAYS = 7;

/** Entity decoding, enough for feed titles. Feeds double-encode often, so this runs twice. */
function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    mdash: "—", ndash: "–", hellip: "…", eacute: "é", pound: "£", euro: "€",
  };
  const once = (s: string) =>
    s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
  return once(once(input));
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * FNV-1a over the whole URL. Truncating a base64 of the URL does NOT work: Google News links share
 * a long common prefix, so a 24-character slice collapsed six articles into two ids and React
 * silently dropped the duplicates.
 */
function hashOf(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** First match of any of the given tag names, CDATA unwrapped. */
function tag(xml: string, ...names: string[]): string {
  for (const name of names) {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (m?.[1]) {
      const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
      // Decode BEFORE stripping, then strip, then decode again. Feeds commonly ship markup
      // entity-encoded (&lt;p&gt;), so stripping first leaves tags that the decode then reveals —
      // which is how "<p>HMRC wins challenge…" and raw <a href> ended up rendered as text.
      const text = decodeEntities(stripTags(decodeEntities(raw)));
      if (text) return text;
    }
  }
  return "";
}

/** Atom puts the link in an attribute rather than the element body. */
function linkOf(xml: string): string {
  const plain = tag(xml, "link");
  if (plain.startsWith("http")) return plain;
  const href = xml.match(/<link[^>]+href=["']([^"']+)["']/i);
  return href?.[1] ?? "";
}

function imageOf(xml: string): string | null {
  const patterns = [
    /<media:content[^>]+url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i,
    /<img[^>]+src=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m?.[1]?.startsWith("http")) return m[1];
  }
  return null;
}

const BULLISH = /\b(surge[sd]?|rall(?:y|ies|ied)|jump[sd]?|soar[sd]?|gain[sd]?|beat[s]?|record high|upgrade[sd]?|outperform|bullish|rebound[sd]?|profit up)\b/i;
const BEARISH = /\b(plunge[sd]?|slump[sd]?|tumble[sd]?|crash(?:es|ed)?|fall[s]?|drop[sd]?|loss(?:es)?|miss(?:es|ed)?|downgrade[sd]?|bearish|selloff|sell-off|recession|layoff[s]?|bankrupt(?:cy)?)\b/i;

/**
 * Keyword sentiment. It is a heuristic, not a model, and it is labelled as such in the UI — an
 * LLM pass would cost a per-article API bill for a signal nobody trades on.
 */
function sentimentOf(text: string): Article["sentiment"] {
  const up = BULLISH.test(text);
  const down = BEARISH.test(text);
  if (up === down) return "neutral";
  return up ? "bullish" : "bearish";
}

/** Tickers written the way headlines write them: (AAPL), $AAPL, "Apple Inc (AAPL)". */
function symbolsOf(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\(([A-Z]{1,5})\)|\$([A-Z]{1,5})\b/g)) {
    const sym = m[1] ?? m[2];
    if (sym && sym.length >= 2) found.add(sym);
  }
  return [...found].slice(0, 4);
}

function parseFeed(xml: string, feed: NewsFeed): Article[] {
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const out: Article[] = [];
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;

  for (const block of blocks.slice(0, MAX_PER_FEED)) {
    const title = tag(block, "title");
    const url = linkOf(block);
    if (!title || !url.startsWith("http")) continue;

    const dateRaw = tag(block, "pubDate", "published", "updated", "dc:date");
    const ts = dateRaw ? Date.parse(dateRaw) : NaN;
    // An unparseable date is treated as now rather than dropped: some feeds omit it entirely, and
    // discarding those would quietly remove whole sources.
    // A feed cannot have published the future, but several of them claim to — Handelsblatt and BNN
    // were both returning timestamps hours ahead of now. Left alone those sort to the top of the
    // page and every one renders as "just now", which is how this was spotted.
    const now = Date.now();
    const publishedAt = Number.isNaN(ts) ? now : Math.min(ts, now);
    if (publishedAt < cutoff) continue;

    const summary = tag(block, "description", "summary", "content:encoded", "content").slice(0, 320);
    const haystack = `${title} ${summary}`;

    out.push({
      id: `${feed.id}:${hashOf(url)}`,
      title,
      url,
      summary,
      source: feed.name,
      sourceId: feed.id,
      category: feed.category,
      publishedAt: new Date(publishedAt).toISOString(),
      imageUrl: imageOf(block),
      symbols: symbolsOf(haystack),
      sentiment: sentimentOf(haystack),
    });
  }
  return out;
}

/** Normalised URL, so the same story syndicated with tracking params collapses to one entry. */
function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Title fingerprint: lower-case, punctuation and stop-words removed, first eight words. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "from", "says", "after"].includes(w))
    .slice(0, 8)
    .join(" ");
}

/**
 * Two stories are the same story if they share a URL or a title fingerprint. Wire copy runs on a
 * dozen sites at once, and without this the feed is the same Reuters headline nine times.
 */
function dedupe(articles: Article[]): Article[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const u = urlKey(a.url);
    const t = titleKey(a.title);
    if (seenUrl.has(u) || (t.length > 12 && seenTitle.has(t))) continue;
    seenUrl.add(u);
    seenTitle.add(t);
    out.push(a);
  }
  return out;
}

/**
 * Round-robin across sources so one publisher cannot own the top of the page.
 *
 * Strict recency ordering does not survive contact with real feeds: several of them stamp articles
 * in the future, and once those are clamped to "now" that single source takes every slot above the
 * fold. BNN Bloomberg filled the first eight cards this way. Within each source the recency order
 * is preserved; it is only the interleaving that changes.
 */
function interleaveBySource(articles: Article[]): Article[] {
  const bySource = new Map<string, Article[]>();
  for (const a of articles) {
    const list = bySource.get(a.sourceId);
    if (list) list.push(a);
    else bySource.set(a.sourceId, [a]);
  }
  const queues = [...bySource.values()];
  const out: Article[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

async function fetchFeed(feed: NewsFeed): Promise<Article[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; DipBuyerNews/1.0; +https://dipbuyer.ai)", accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return [];
    return parseFeed(await res.text(), feed);
  } catch {
    // One slow or broken feed must not take the page down with it.
    return [];
  }
}

export interface NewsResult {
  articles: Article[];
  /** Feeds that actually returned something, so the UI can say "x of y sources" honestly. */
  sourcesOk: number;
  sourcesTried: number;
  fetchedAt: string;
}

export async function getNews(category?: NewsCategory | "all", limit = 60): Promise<NewsResult> {
  const feeds = !category || category === "all" ? NEWS_FEEDS : NEWS_FEEDS.filter((f) => f.category === category);
  const results = await Promise.all(feeds.map(fetchFeed));

  const merged = interleaveBySource(
    dedupe(
      results
        .flat()
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
    ),
  );

  return {
    articles: merged.slice(0, limit),
    sourcesOk: results.filter((r) => r.length > 0).length,
    sourcesTried: feeds.length,
    fetchedAt: new Date().toISOString(),
  };
}
