import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Learn value investing — DipBuyer AI",
  description:
    "Plain-English guides to value investing the Peter Lynch way: the six company types, PEG, dividend cover, what a backtest can and cannot tell you, and the numbers that matter.",
};

const CATEGORIES = [
  ["Slow growers", "Big, mature companies growing about as fast as the economy. Bought for a safe, well-covered dividend — and sold if the dividend stops looking safe.", "hue-sky"],
  ["Stalwarts", "Large, dependable companies growing steadily. Bought at a fair price for downside protection; Lynch took a 30-50% gain and moved on.", "hue-violet"],
  ["Fast growers", "Smaller companies growing 20%+ a year. The source of Lynch's biggest winners, if the growth is funded from cash flow and has room to continue.", "hue-emerald"],
  ["Cyclicals", "Earnings rise and fall with the economy. The P/E works backwards here: it looks cheapest at the peak. Bought when earnings are depressed, sold when they look best.", "hue-amber"],
  ["Turnarounds", "Battered companies that might recover. The first question is survival, not upside.", "hue-rose"],
  ["Asset plays", "Companies sitting on assets the market has overlooked: property, cash, holdings, licences.", "hue-sky"],
];

const NUMBERS = [
  ["PEG ratio", "P/E divided by the earnings growth rate.", "Lynch's shorthand for 'am I paying too much for this growth?'. At 1.0 the price roughly matches the growth; at 0.5 the market may be asleep; at 2.0 you are paying double."],
  ["Dividend cover", "Earnings divided by the dividend.", "A high yield means nothing if the company cannot pay it. Cover under about 1.5x is a warning, not a bargain."],
  ["Debt to equity", "Borrowings compared with shareholders' money.", "Lynch's simplest safety test. Debt is what turns a bad year into a permanent loss — though for banks and utilities the ratio measures the business model, not recklessness."],
  ["Free cash flow", "Cash left after running and maintaining the business.", "Profit is an opinion; cash is a fact. A 'cheap' company burning cash is usually a trap rather than a bargain."],
  ["Drawdown", "The worst fall from a peak.", "The number that decides whether you can actually hold a strategy. Ours fell 22% at its worst in a hypothetical 2016-2025 backtest."],
];

/**
 * Outside sources, grouped by what they are for rather than dumped as one list. Titles are the
 * publishers' own, so a reader can tell what they are clicking before they leave the site.
 */
const READING = [
  {
    heading: "The method",
    items: [
      { title: "Warren Buffett's investment strategy and rules", source: "Investing.com", href: "https://www.investing.com/academy/trading/warren-buffett-investment-strategy-rules-fortune/" },
      { title: "Value investing, defined", source: "Investopedia", href: "https://www.investopedia.com/terms/v/valueinvesting.asp" },
      { title: "Growth vs value investing", source: "Forbes Advisor", href: "https://www.forbes.com/uk/advisor/investing/growth-investing/" },
    ],
  },
  {
    heading: "Buying the dip",
    items: [
      { title: "Buy the dip", source: "Britannica Money", href: "https://www.britannica.com/money/buy-the-dip" },
      { title: "Retail traders unbowed by market tumult preach dip-buying mantra", source: "Bloomberg", href: "https://www.bloomberg.com/news/articles/2025-04-15/retail-traders-unbowed-by-market-tumult-preach-dip-buying-mantra" },
      { title: "'For our country': China's patriots are buying the dip", source: "Reuters", href: "https://www.reuters.com/business/finance/for-our-country-chinas-patriots-are-buying-dip-2025-04-22/" },
    ],
  },
  {
    heading: "Markets and AI agents",
    items: [
      { title: "Global markets Breakingviews", source: "Reuters", href: "https://www.reuters.com/breakingviews/global-markets-breakingviews-2025-05-16/" },
      { title: "How AI agents will change the digital assets industry forever", source: "Forbes Tech Council", href: "https://www.forbes.com/councils/forbestechcouncil/2025/06/11/how-ai-agents-will-change-the-digital-assets-industry-forever/" },
      { title: "How the stock market works", source: "Investopedia", href: "https://www.investopedia.com/articles/investing/082614/how-stock-market-works.asp" },
    ],
  },
];

export default function LearnPage() {
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Learn</span>
        <h1>
          Value investing, <span className="grad-text">explained plainly</span>
        </h1>
        <p>
          Everything the engine does rests on a simple idea: a share is a piece of a business, and sometimes the market
          prices that business at less than it is worth. These pages explain how we look for that, and what the numbers on a
          research page actually mean.
        </p>
      </div>

      <div className="two-col" style={{ alignItems: "center", marginTop: 8 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>What value investing is</h2>
          <p className="muted">
            A company&apos;s share price bounces around far more than the business itself. Value investors estimate what the
            business is worth, then buy when the price is clearly below it and sell when it runs well above. The gap between
            the two is the margin of safety: room to be wrong and still do all right.
          </p>
          <p className="muted">
            Peter Lynch&apos;s version is practical rather than academic. Judge a company against others of its own type,
            insist on a sensible price for the growth you are buying, check the balance sheet, and hold while the story is
            intact. Our engine is that checklist, written as code.
          </p>
        </div>
        <ValueGapChart />
      </div>

      <div className="section-head">
        <h2>
          The six <span className="grad-text">company types</span>
        </h2>
        <p>Lynch&apos;s first move was never a valuation. It was deciding what kind of company he was looking at, because each type is judged differently.</p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(290px, 100%), 1fr))" }}>
        {CATEGORIES.map(([title, body, hue]) => (
          <div className={`card idea-card ${hue}`} key={title}>
            <span className="tag">{title}</span>
            <p style={{ fontSize: "0.92rem" }}>{body}</p>
          </div>
        ))}
      </div>
      <p className="footnote">
        The engine assigns one of these to every company from its filings, then applies that type&apos;s checklist. See the
        exact thresholds on the <a href="/methodology">methodology page</a>.
      </p>

      <div className="section-head">
        <h2>The numbers that matter</h2>
        <p>Five you will meet on every research page.</p>
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="data-table" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Term</th>
              <th style={{ textAlign: "left" }}>What it is</th>
              <th style={{ textAlign: "left" }}>Why it matters</th>
            </tr>
          </thead>
          <tbody>
            {NUMBERS.map(([term, what, why]) => (
              <tr key={term}>
                <td>
                  <b>{term}</b>
                </td>
                <td className="muted">{what}</td>
                <td className="muted">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head">
        <h2>
          What a backtest <span className="grad-text">can and cannot</span> tell you
        </h2>
        <p>Most investing claims you read are backtests. Here is how to judge one, including ours.</p>
      </div>
      <div className="steps">
        <div className="card step hue-violet">
          <div className="n">✓</div>
          <h3>Ask what it could see</h3>
          <p>
            A test that uses today&apos;s index members ignores the companies that failed, and one that reads accounts before
            they were published is reading the future. Ours uses membership as it stood each month and filing dates from the
            SEC.
          </p>
        </div>
        <div className="card step hue-sky">
          <div className="n">✓</div>
          <h3>Ask for both halves</h3>
          <p>
            A rule tuned on one period usually reverses in the next. We judge every change on 2016-2020 and 2021-2025
            separately, and reject anything that only works in one.
          </p>
        </div>
        <div className="card step hue-amber">
          <div className="n">✓</div>
          <h3>Ask what it lost</h3>
          <p>
            Returns without the worst fall are half a story. A strategy you abandon at the bottom returns nothing, which is
            why drawdown sits next to every return figure we publish.
          </p>
        </div>
      </div>

      <div className="card about-cta" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>See it on a real company</h2>
        <p className="muted">
          Every research page shows the verdict, the checklist behind it, two fair-value estimates and where the price sits
          in its 52-week range. Start with a household name and see how the criteria land.
        </p>
        <div className="chip-row" style={{ marginTop: 16, marginBottom: 0 }}>
          {["AAPL", "KO", "NKE", "JPM"].map((s) => (
            <a key={s} className="btn btn-outline btn-sm" href={`/stock/${s}`}>
              {s}
            </a>
          ))}
          <a className="btn btn-brand" href="/opportunities">
            Browse stock ideas
          </a>
        </div>
      </div>

      <div className="section-head">
        <h2>Further reading</h2>
        <p>Outside sources, none of them ours. We link to the argument, not just the conclusion.</p>
      </div>
      <div className="grid reading-grid">
        {READING.map((group) => (
          <div className="card" key={group.heading}>
            <h3 style={{ marginTop: 0, fontSize: "1rem" }}>{group.heading}</h3>
            <ul className="reading-list">
              {group.items.map((item) => (
                <li key={item.href}>
                  <a href={item.href} target="_blank" rel="noopener noreferrer">
                    {item.title}
                  </a>
                  <span className="src">{item.source}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="footnote">
        Educational content only, not personal advice or a recommendation to buy or sell. Capital is at risk: the value of
        investments can fall as well as rise and you may get back less than you invest. External links are provided for
        information; we are not responsible for their content and linking does not imply endorsement.
      </p>
    </div>
  );
}

/**
 * The standard value-investing diagram, following the reference layout closely.
 *
 * The margin of safety is the BAND between the intrinsic value estimate and a lower discount line —
 * not a single measured arrow, and not the dip itself. Earlier passes at this drew it both of those
 * other ways and both were wrong: the dip is where you buy, the band is the discount you demand.
 *
 * Drawn as vector rather than using a bitmap so it stays sharp and follows the theme. Colours come
 * from the palette, so the same file works on light and dark.
 */
function ValueGapChart() {
  // Two parallel rising lines. Lower y = higher value.
  const intrinsic = "M 108 300 L 752 200";
  const discount = "M 108 348 L 752 248";

  // The market price. The anchors at x=360 and x=452 sit exactly ON the discount line, which is
  // what lets the shaded dip below close along it with a straight edge.
  const price =
    "M 108 392 C 132 356, 152 322, 178 314 C 200 308, 214 314, 234 308 C 254 302, 264 248, 288 206 C 302 180, 318 174, 334 196 C 344 232, 352 272, 360 309 C 372 344, 392 372, 412 368 C 432 364, 444 330, 452 295 C 462 254, 478 214, 498 196 C 512 184, 526 194, 536 212 C 544 226, 550 238, 560 232 C 574 222, 584 198, 598 172 C 620 132, 646 96, 672 76 C 700 58, 726 62, 748 60";

  // Margin of safety: the parallelogram between the two lines, over the stretch that matters.
  const band = "M 336 265 L 452 247 L 452 295 L 336 313 Z";
  // Where the price fell through the discount line — the buy.
  const dip = "M 360 309 C 372 344, 392 372, 412 368 C 432 364, 444 330, 452 295 Z";

  return (
    <figure className="card value-gap">
      <svg
        viewBox="0 0 800 470"
        role="img"
        aria-label="A market price line swinging around a steadily rising intrinsic value estimate, with a lower discount line beneath it. The band between the two is the margin of safety. Where the price falls through the discount line the business is bought; where it runs well above intrinsic value, selling is considered."
      >
        <defs>
          <marker id="vg-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* Axes */}
        <line x1="92" y1="404" x2="764" y2="404" stroke="var(--brand)" strokeWidth="2.5" />
        <line x1="92" y1="404" x2="92" y2="44" stroke="var(--brand)" strokeWidth="2.5" />
        <text x="46" y="224" textAnchor="middle" transform="rotate(-90, 46, 224)" fontSize="15" fontWeight="700" fill="var(--brand)" letterSpacing="1.5">
          VALUE
        </text>
        <text x="428" y="440" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--brand)" letterSpacing="1.5">
          TIME
        </text>

        {/* Shaded regions, under the lines */}
        <path d={band} fill="var(--warning)" opacity="0.3" />
        <path d={dip} fill="var(--brand)" opacity="0.22" />

        {/* The three lines */}
        <path d={discount} fill="none" stroke="var(--brand)" strokeWidth="2.5" opacity="0.55" />
        <path d={intrinsic} fill="none" stroke="var(--warning)" strokeWidth="2.5" />
        <path d={price} fill="none" stroke="var(--text)" strokeWidth="3" strokeLinecap="round" />

        {/* Margin of safety, named inside its own band */}
        <text x="394" y="274" textAnchor="middle" fontSize="12.5" fontWeight="800" fill="var(--warning-ink, var(--warning))" letterSpacing="0.06em">
          MARGIN
        </text>
        <text x="394" y="291" textAnchor="middle" fontSize="12.5" fontWeight="800" fill="var(--warning-ink, var(--warning))" letterSpacing="0.06em">
          OF SAFETY
        </text>

        {/* Callouts */}
        <g fill="var(--brand)" color="var(--brand)">
          <text x="128" y="168" fontSize="15.5" fontWeight="800" letterSpacing="0.04em">
            MARKET PRICE
          </text>
          <path d="M 262 176 L 292 194" fill="none" stroke="currentColor" strokeWidth="2.5" markerEnd="url(#vg-tip)" />

          <text x="372" y="96" fontSize="15.5" fontWeight="800" letterSpacing="0.04em">
            CONSIDER SELLING
          </text>
          <path d="M 568 100 L 626 124" fill="none" stroke="currentColor" strokeWidth="2.5" markerEnd="url(#vg-tip)" />
        </g>

        {/* Below its line with the arrow pointing UP at it, as the reference has it. Far enough to
            the right that it cannot be read as a second label for the margin-of-safety band. */}
        <g fill="var(--warning)" color="var(--warning)">
          <path d="M 706 304 L 706 212" fill="none" stroke="currentColor" strokeWidth="2.5" markerEnd="url(#vg-tip)" />
          <text x="552" y="292" fontSize="14.5" fontWeight="800" letterSpacing="0.03em">
            INTRINSIC VALUE
          </text>
          <text x="552" y="311" fontSize="14.5" fontWeight="800" letterSpacing="0.03em">
            ESTIMATE
          </text>
        </g>

        {/* The buy note, boxed and pointing back at the dip */}
        <g color="var(--brand)">
          <rect x="498" y="326" width="236" height="70" rx="8" fill="var(--bg-elevated)" stroke="var(--brand)" strokeWidth="2" />
          <text x="514" y="350" fontSize="13" fill="var(--text)">
            Buy when the market offers
          </text>
          <text x="514" y="368" fontSize="13" fill="var(--text)">
            the business at a discount
          </text>
          <text x="514" y="386" fontSize="13" fill="var(--text)">
            to fair value
          </text>
          <path d="M 492 360 L 456 350" fill="none" stroke="currentColor" strokeWidth="2.5" markerEnd="url(#vg-tip)" />
        </g>
      </svg>
      <figcaption className="faint small">
        The price swings; the business changes slowly. The band between what it is worth and the
        price you insist on paying is the margin of safety — the room you have to be wrong.
      </figcaption>
    </figure>
  );
}
