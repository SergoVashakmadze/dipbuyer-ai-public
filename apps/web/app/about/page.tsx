import type { Metadata } from "next";
import { IconArrow, IconBook, IconChart, IconLightbulb, IconShield } from "../../components/icons";
import { FUND_URL } from "../../components/site-header";

export const metadata: Metadata = {
  title: "About DipBuyer AI — a technology demonstration of an AI agent for value investing",
  description:
    "DipBuyer AI is a technology demonstration, not offered as a service. It shows how Peter Lynch's value-investing criteria can identify undervalued US companies, flag overvalued ones, and show the evidence behind every decision.",
};

const PRINCIPLES = [
  {
    hue: "hue-violet",
    icon: <IconBook />,
    title: "A named method, published in full",
    body: "Peter Lynch's rules, written down as a versioned config: six company types, each with its own checklist and thresholds. You can read the exact rules on the methodology page, and the config's hash is stamped into every decision.",
  },
  {
    hue: "hue-sky",
    icon: <IconLightbulb />,
    title: "Rules decide, the AI explains",
    body: "Verdicts come from deterministic code, not a language model. The AI writes the plain-English story around a decision; it can never override one. That is what makes the engine testable and auditable.",
  },
  {
    hue: "hue-emerald",
    icon: <IconChart />,
    title: "Tested honestly, including the failures",
    body: "Every rule change is judged over 2016-2020 and 2021-2025 separately, on point-in-time index membership with delisted companies included. Most ideas we test are rejected, and we publish that.",
  },
  {
    hue: "hue-amber",
    icon: <IconShield />,
    title: "Recorded and verifiable",
    body: "Each decision is recorded with its inputs, checklist and data sources, then hashed. Whole runs are anchored on Monad as one Merkle root (earlier records on Algorand), so a verdict you saw last year can be verified today.",
  },
];

export default function AboutPage() {
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">About</span>
        <h1>
          An AI agent for <span className="grad-text">value investing</span>
        </h1>
        <p>
          DipBuyer AI is a technology demonstration. It looks for good companies trading below what they are worth, using
          Peter Lynch&apos;s criteria, and flags the ones a portfolio holds that have become expensive. It shows its working for every decision, so you can judge the
          reasoning rather than trust a score.
        </p>
      </div>

      <figure className="about-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/agent-analysing-markets.webp"
          srcSet="/images/agent-analysing-markets-800.webp 800w, /images/agent-analysing-markets.webp 1600w, /images/agent-analysing-markets-2560.webp 2560w"
          sizes="(max-width: 900px) 100vw, 1200px"
          alt="An AI agent analysing stock market data across several screens"
          width={1600}
          height={897}
          loading="eager"
        />
        <figcaption>
          <a href="https://www.vecteezy.com/free-photo/robot" target="_blank" rel="noopener noreferrer">
            Robot Stock photos by Vecteezy
          </a>
        </figcaption>
      </figure>

      <div className="section-head">
        <h2>
          Design <span className="grad-text">principles</span>
        </h2>
        <p>Four principles that shape how the software is built.</p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))" }}>
        {PRINCIPLES.map((p) => (
          <div className={`card feature ${p.hue}`} key={p.title}>
            <span className="icon">{p.icon}</span>
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </div>
        ))}
      </div>

      <div className="section-head">
        <h2>How it works, end to end</h2>
        <p>The same engine runs the research pages, the backtests and the investing agent demonstration.</p>
      </div>
      <div className="steps">
        <div className="card step hue-violet">
          <div className="n">1</div>
          <h3>Screen</h3>
          <p>
            Company filings from the SEC and prices from the market, read at the dates they were actually available, so a
            backtest can never see the future.
          </p>
        </div>
        <div className="card step hue-sky">
          <div className="n">2</div>
          <h3>Decide</h3>
          <p>
            Each company is classified as a slow grower, stalwart, fast grower, cyclical, turnaround or asset play, then
            scored on that type&apos;s checklist.
          </p>
        </div>
        <div className="card step hue-emerald">
          <div className="n">3</div>
          <h3>Propose, with a person in control</h3>
          <p>
            The demonstration shows how the agent could propose buys and sells, sized as the backtest sizes them, for a
            person to approve. It is not offered for trading until the required licences, penetration testing and security
            audits are complete.
          </p>
        </div>
      </div>

      <div className="card about-cta">
        <h2 style={{ marginTop: 0 }}>Where this is going</h2>
        <p className="muted">
          DipBuyer AI is research software today: it runs on paper, and it is candid that the strategy has not beaten a
          simple S&amp;P 500 tracker over the last decade. The work in progress is honest signal research, a small and
          mid-cap universe where value investing has more room, and the regulatory groundwork for advice.
        </p>
        <div className="chip-row" style={{ marginTop: 16, marginBottom: 0 }}>
          <a className="btn btn-brand" href="/methodology">
            Read the methodology
          </a>
          <a className="btn btn-outline" href="/learn">
            Learn value investing
          </a>
          <a className="btn btn-outline" href={FUND_URL} target="_blank" rel="noopener noreferrer">
            Buy The Dip Fund <IconArrow width={15} height={15} />
          </a>
        </div>
      </div>

      <div className="section-head" style={{ marginBottom: 16 }}>
        <h2>Contact</h2>
        <p>Questions about the demonstration or the research.</p>
      </div>
      <div className="tile-grid four">
        <a className="tile hue-violet" href="mailto:hello@dipbuyer.ai">
          <div className="tile-label">Email</div>
          <div className="tile-value" style={{ fontSize: "1.05rem" }}>
            hello@dipbuyer.ai
          </div>
        </a>
        <a className="tile hue-sky" href="tel:+442031891661">
          <div className="tile-label">Phone</div>
          <div className="tile-value" style={{ fontSize: "1.05rem" }}>
            +44 203 189 1661
          </div>
        </a>
        <div className="tile hue-emerald">
          <div className="tile-label">Where we are</div>
          <div className="tile-value" style={{ fontSize: "1.05rem" }}>
            London, UK
          </div>
        </div>
        <a className="tile hue-amber" href="https://www.linkedin.com/company/dipbuyer-ai/" target="_blank" rel="noopener noreferrer">
          <div className="tile-label">Follow</div>
          <div className="tile-value" style={{ fontSize: "1.05rem" }}>
            LinkedIn
          </div>
        </a>
      </div>
    </div>
  );
}
