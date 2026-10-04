import { DashboardStats } from "../components/dashboard-stats";
import { TickerSearch } from "../components/research-ui";
import { IconArrow, IconBot, IconChart, IconLightbulb, IconShield } from "../components/icons";
import { IDEAS } from "../lib/ideas";
import { MarketNews, MarketOverview } from "../components/tradingview";

const FEATURES = [
  { href: "/opportunities", hue: "hue-violet", icon: <IconLightbulb />, title: "Stock ideas", body: "Dip buys, Lynch bargains and quality on sale, screened daily from the engine's verdicts." },
  { href: "/stock/AAPL", hue: "hue-sky", icon: <IconChart />, title: "Stock research", body: "One company in depth: verdict, intrinsic value, the Lynch checklist, chart and financials." },
  { href: "/agent", hue: "hue-emerald", icon: <IconBot />, title: "Investing agent (demo)", body: "Demonstrates how an agent could screen the market and propose trades, sized like the backtest, for a person to approve." },
  { href: "/monad", hue: "hue-amber", icon: <IconShield />, title: "Provable on Monad", body: "Every verdict is hashed and a whole run is anchored on Monad as one root, so anyone can check a decision in their browser." },
];

/**
 * Strategy config v0.4.0 backtest, 2016-01 to 2025-12, monthly, point-in-time S&P 500 incl. delisted names
 * (internal notes, not published). Shown with the benchmark that beat it, not only the one it beat.
 */
const TRACK = [
  { label: "DipBuyer (hypothetical backtest)", full: "13.46%", h1: "11.01%", h2: "15.07%", us: true },
  { label: "S&P 500 (SPY)", full: "14.60%", h1: "14.87%", h2: "13.94%" },
  { label: "Equal-weight S&P 500 (RSP)", full: "11.60%", h1: "12.80%", h2: "9.80%" },
];

export default function Home() {
  return (
    <div>
      <section className="hero">
        <span className="pill">
          <span className="dot" /> Peter Lynch&apos;s method · every decision explained
        </span>
        <h1>An agent that buys great companies on the dip. And keeps the receipts.</h1>
        <p className="lead">
          DipBuyer AI screens the market with Peter Lynch&apos;s named criteria, shows you exactly why each stock passes or fails,
          and records every decision on an audit trail you can verify.
        </p>
        <TickerSearch hero placeholder="Search a ticker, e.g. NKE" />
        <div className="hero-links">
          <span>Try</span>
          {["AAPL", "NKE", "KO", "JPM", "COST"].map((s) => (
            <a key={s} href={`/stock/${s}`}>
              {s}
            </a>
          ))}
        </div>
      </section>

      <div className="feature-grid">
        {FEATURES.map((f) => (
          <a key={f.href} className={`card feature ${f.hue}`} href={f.href}>
            <span className="icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <span className="arrow">
              <IconArrow width={16} height={16} />
            </span>
          </a>
        ))}
      </div>

      <div className="section-head">
        <h2>
          Stock ideas, screened <span className="grad-text">the Lynch way</span>
        </h2>
        <p>Every list starts from the engine&apos;s verdict and adds one piece of evidence a dip buyer checks next.</p>
      </div>
      <div className="idea-grid">
        {IDEAS.filter((i) => i.id !== "all").map((i) => (
          <a key={i.id} className={`card idea-card ${i.hue}`} href={`/opportunities?idea=${i.id}`}>
            <span className="tag">{i.tag}</span>
            <h3>{i.label}</h3>
            <p>{i.description}</p>
            <div className="foot">
              <span className="count">Open list</span>
              <span className="go">
                <IconArrow width={15} height={15} />
              </span>
            </div>
          </a>
        ))}
      </div>

      <div className="section-head">
        <h2>
          Markets <span className="grad-text">today</span>
        </h2>
        <p>
          Where prices stand and what is moving them. The &quot;Value vs growth&quot; tab tracks the comparison our research turns on.{" "}
          <a href="/markets">Heatmaps, sectors and movers</a>
        </p>
      </div>
      <div className="two-col">
        <div className="card flush">
          <MarketOverview height={480} />
        </div>
        <div className="card flush">
          <MarketNews height={480} />
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>Market widgets by TradingView.</p>

      <div className="section-head">
        <h2>
          How a decision <span className="grad-text">is made</span>
        </h2>
        <p>Deterministic rules decide. The AI explains; it never overrides the verdict.</p>
      </div>
      <div className="steps">
        <div className="card step hue-violet">
          <div className="n">1</div>
          <h3>Classify the company</h3>
          <p>Slow grower, stalwart, fast grower, cyclical, turnaround or asset play. Lynch judged each type by different rules.</p>
        </div>
        <div className="card step hue-sky">
          <div className="n">2</div>
          <h3>Score the checklist</h3>
          <p>PEG, balance sheet, cash flow, growth consistency, inventories. Each criterion shows its value, target and result.</p>
        </div>
        <div className="card step hue-emerald">
          <div className="n">3</div>
          <h3>Record the proof</h3>
          <p>The full decision, inputs and data sources are hashed, so the verdict you saw can be verified later.</p>
        </div>
      </div>

      <a className="card feature hue-amber" href="/monad" style={{ display: "block", marginTop: 16 }}>
        <span className="icon">
          <IconShield />
        </span>
        <h3>Provable on Monad</h3>
        <p>
          The whole 2016-2025 backtest, 53,384 decisions, is anchored on Monad testnet in a single transaction. Pick any decision and
          your browser proves it against that root, without contacting DipBuyer. See how it works, or{" "}
          <span className="grad-text">verify one now</span>.
        </p>
        <span className="arrow">
          <IconArrow width={16} height={16} />
        </span>
      </a>

      <div className="section-head">
        <h2>
          Hypothetical <span className="grad-text">backtest</span>
        </h2>
        <p>Compound annual growth in a hypothetical 2016-2025 backtest, next to the benchmarks. The S&amp;P 500 won over the full decade.</p>
      </div>
      <div className="card perf-wrap" style={{ padding: "8px 8px 16px" }}>
        <table className="perf-table">
          <thead>
            <tr>
              <th>Annual return (CAGR)</th>
              <th>2016-2025</th>
              <th>2016-2020</th>
              <th>2021-2025</th>
            </tr>
          </thead>
          <tbody>
            {TRACK.map((t) => (
              <tr key={t.label} className={t.us ? "us" : undefined}>
                <td>{t.label}</td>
                <td>{t.full}</td>
                <td>{t.h1}</td>
                <td>{t.h2}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote" style={{ padding: "0 14px" }}>
          Hypothetical backtest of strategy config v0.4.0: monthly rebalancing, point-in-time S&amp;P 500 membership including
          delisted companies, SEC EDGAR fundamentals at their filing dates, idle cash held in SPY. Max drawdown 22.0%. Backtests are
          not live results and past performance is not a guide to future returns. <a href="/methodology">Methodology</a>
        </p>
      </div>

      <DashboardStats />
    </div>
  );
}
