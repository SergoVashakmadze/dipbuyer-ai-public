import type { Metadata } from "next";
import { getNews } from "../../lib/news/aggregate";
import { NEWS_FEEDS } from "../../lib/news/feeds";
import { NewsFeedView } from "./news-feed";

export const metadata: Metadata = {
  title: "Market news — DipBuyer AI",
  description:
    "Financial news aggregated from Reuters, Bloomberg, the FT, the WSJ, CNBC and other sources, de-duplicated and grouped by market, economy, technology and crypto.",
};

/**
 * Rebuilt at most every 5 minutes, and only when somebody asks for the page.
 *
 * The alternative — a scheduled job pulling 51 feeds around the clock — runs thousands of times a
 * month whether or not anyone is reading, and on a private repo that is billed CI time. For
 * headlines, five minutes of staleness is not worth paying for.
 */
export const revalidate = 300;

export default async function NewsPage() {
  const { articles, sourcesOk, sourcesTried, fetchedAt } = await getNews("all", 72);

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">News</span>
        <h1>
          The market, <span className="grad-text">as it is reported</span>
        </h1>
        <p>
          Headlines from {NEWS_FEEDS.length} financial and technology sources, merged and
          de-duplicated so the same wire story does not appear nine times. We link out; we do not
          rewrite anyone&apos;s reporting.
        </p>
      </div>

      <NewsFeedView
        initial={articles}
        sourcesOk={sourcesOk}
        sourcesTried={sourcesTried}
        fetchedAt={fetchedAt}
      />

      <p className="footnote">
        Headlines and summaries belong to their publishers and link to the original article. Their
        inclusion is not an endorsement, and none of it is a recommendation to buy or sell. The
        bullish/bearish tag is a crude keyword heuristic, not analysis — treat it as a rough filter
        and read the article.
      </p>
    </div>
  );
}
