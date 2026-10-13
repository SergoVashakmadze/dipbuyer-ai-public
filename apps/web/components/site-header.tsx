"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AuthButton } from "./auth-button";
import { TickerSearch } from "./research-ui";
import { ThemeToggle } from "./theme";
import { OnboardingStatus } from "./onboarding-gate";
import { AdminLink, WatchlistBell } from "./watchlist-ui";
import { EcosystemMenu } from "./ecosystem-menu";
import { BrandName } from "./brand-name";
import {
  BrandMark,
  IconBook,
  IconBot,
  IconChart,
  IconChevron,
  IconMenu,
  IconClose,
  IconFile,
  IconGrid,
  IconHistory,
  IconLightbulb,
  IconLink,
  IconShield,
  IconStar,
  IconUser,
  IconWallet,
  IconMail,
  IconPhone,
  IconPin,
  IconX,
  IconLinkedIn,
  IconTelegram,
  IconGitHub,
} from "./icons";

interface Item {
  href: string;
  label: string;
  hint: string;
  icon: ReactNode;
}

/** Routes grouped by the job a user is doing, not listed flat. */
const GROUPS: Array<{ label: string; hue: string; items: Item[] }> = [
  {
    label: "Research",
    hue: "hue-violet",
    items: [
      { href: "/opportunities", label: "Stock ideas", hint: "Dip buys, Lynch bargains, quality on sale", icon: <IconLightbulb /> },
      { href: "/stock/AAPL", label: "Stock research", hint: "Verdict, intrinsic value, checklist, chart", icon: <IconChart /> },
      { href: "/insiders", label: "Insider buying", hint: "Directors and officers buying their own stock", icon: <IconUser /> },
      { href: "/tools/fair-value", label: "Fair value calculator", hint: "Lynch and Graham fair value for any stock", icon: <IconChart /> },
      { href: "/markets", label: "Markets", hint: "Heatmap, movers and a full-market screener", icon: <IconGrid /> },
      { href: "/news", label: "News", hint: "Headlines from several sources, merged and de-duplicated", icon: <IconFile /> },
      { href: "/learn", label: "Learn", hint: "Value investing, explained plainly", icon: <IconBook /> },
    ],
  },
  {
    label: "Strategy",
    hue: "hue-sky",
    items: [
      { href: "/methodology", label: "Methodology", hint: "How the Peter Lynch engine decides", icon: <IconBook /> },
      { href: "/backtest", label: "Backtest", hint: "Point-in-time, survivorship-controlled", icon: <IconHistory /> },
    ],
  },
  {
    label: "Portfolio",
    hue: "hue-emerald",
    items: [
      { href: "/portfolio", label: "Portfolio", hint: "Positions, P&L and decision history", icon: <IconWallet /> },
      { href: "/models", label: "Model portfolios", hint: "Demonstration: how a model could be followed, with trades for approval", icon: <IconBot /> },
      { href: "/watchlist", label: "Watchlist", hint: "Alerts when a stock turns buy, dips or insiders buy", icon: <IconStar /> },
      { href: "/digest", label: "Weekly digest", hint: "Your week in one email, opt-in", icon: <IconMail /> },
      { href: "/onboarding", label: "Onboarding", hint: "Identity check and suitability", icon: <IconUser /> },
    ],
  },
  {
    label: "Trust",
    hue: "hue-amber",
    items: [
      { href: "/audit", label: "Decision audit", hint: "Every decision with its evidence", icon: <IconShield /> },
      { href: "/verify", label: "Verify a record", hint: "Check a hash against the chain", icon: <IconLink /> },
      { href: "/monad", label: "Provable on Monad", hint: "How decisions are anchored and checked", icon: <IconShield /> },
      { href: "/verify/monad", label: "Verify on Monad", hint: "Prove a decision against a batch root", icon: <IconLink /> },
      { href: "/fund", label: "Fund on Monad", hint: "Simulated any-chain payment via Aurora Intents", icon: <IconWallet /> },
      { href: "/reports", label: "Reports", hint: "Audit packs and governance reports", icon: <IconFile /> },
    ],
  },
];

/**
 * The bull mark is light artwork made for dark backgrounds, so it disappeared on the light theme.
 * Two files, swapped by theme in CSS: the original for dark, a brightness-inverted "ink" copy for light.
 */
function BrandLogo({ eager = false }: { eager?: boolean }) {
  return (
    <span className="brand-logo" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="on-light" src="/images/dipbuyer-logo-ink.webp" alt="" width={34} height={34} loading={eager ? "eager" : "lazy"} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="on-dark" src="/images/dipbuyer-logo.webp" alt="" width={34} height={34} loading={eager ? "eager" : "lazy"} />
    </span>
  );
}

export const FUND_URL = "https://www.buythedip.fund/";

/** Channels the product actually runs on; the bots are the old site's, kept because they are live. */
const SOCIALS: Array<{ href: string; label: string; icon: ReactNode }> = [
  { href: "https://x.com/DipBuyer_AI", label: "DipBuyer AI on X", icon: <IconX /> },
  { href: "https://www.linkedin.com/company/dipbuyer-ai/", label: "DipBuyer AI on LinkedIn", icon: <IconLinkedIn /> },
  { href: "https://t.me/DipBuyer_TradingBot", label: "DipBuyer Telegram bot", icon: <IconTelegram /> },
  { href: "https://github.com/SergoVashakmadze", label: "GitHub", icon: <IconGitHub /> },
];

/**
 * Site-wide notice, first thing on every page, in the same form and wording as iomarkets.io's demo banner.
 * Not dismissible: the site is a technology demonstration and nothing on it is offered until licences,
 * penetration testing and security audits are complete.
 */
export function DemoNotice() {
  return (
    <div className="site-notice" role="note" aria-label="Demonstration only">
      <p>
        <strong>Demonstration only.</strong> This site is a technology demonstration and is not offered as a service. Nothing here is
        available for investment, trading, advice or payment until the required licences, penetration testing and security audits are
        complete.
      </p>
    </div>
  );
}

export function SiteHeader() {
  const path = usePathname() ?? "/";
  const inGroup = (items: Item[]) => items.some((i) => path.startsWith(i.href.split("/").slice(0, 2).join("/")));
  // Phones get a full-screen menu instead of the hover dropdowns, which cannot fit or be hovered there.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => window.innerWidth > 1220 && setOpen(false);
    document.body.classList.add("menu-open");
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.classList.remove("menu-open");
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/" aria-label="DipBuyer AI home">
          <BrandLogo eager />
          <span className="brand-name">
            DipBuyer <span className="ai">AI</span>
            <sup className="tm">™</sup>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="/agent" className={path.startsWith("/agent") ? "nav-link agent-link active" : "nav-link agent-link"}>
            <span className="spark">
              <IconBot />
            </span>
            Agent
          </a>
          {GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <button type="button" className={inGroup(g.items) ? "nav-trigger nav-link active" : "nav-trigger"} aria-haspopup="true">
                {g.label}
                <IconChevron />
              </button>
              <div className={`nav-menu ${g.hue}`} role="menu">
                {g.items.map((i) => (
                  <a key={i.href} href={i.href} role="menuitem">
                    <span className="icon">{i.icon}</span>
                    <span>
                      <b>{i.label}</b>
                      <small>{i.hint}</small>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="topbar-actions">
          <TickerSearch compact placeholder="Search a ticker" />
          <span className="bar-extras">
            <ThemeToggle />
            <AdminLink />
            <WatchlistBell />
            <OnboardingStatus />
            <AuthButton />
          </span>
          {/* Ecosystem is the last item on the right, as on every other IoMarkets site; on phones it follows the menu button. */}
          <EcosystemMenu />
          <button
            type="button"
            className="menu-toggle"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
          <EcosystemMenu mobile />
        </div>
      </div>
      {open && (
        <nav className="mobile-menu" id="mobile-menu" aria-label="Main">
          <div className="mobile-actions">
            <ThemeToggle />
            <AdminLink />
            <WatchlistBell />
            <AuthButton />
          </div>
          <TickerSearch compact placeholder="Search a ticker" />
          <a href="/agent" className={path.startsWith("/agent") ? "mobile-agent active" : "mobile-agent"}>
            <span className="spark">
              <IconBot />
            </span>
            Investing agent (demo)
          </a>
          {GROUPS.map((g) => (
            <div className={`mobile-group ${g.hue}`} key={g.label}>
              <h4>{g.label}</h4>
              {g.items.map((i) => (
                <a key={i.href} href={i.href} className={path === i.href ? "active" : undefined}>
                  <span className="icon">{i.icon}</span>
                  <span>
                    <b>{i.label}</b>
                    <small>{i.hint}</small>
                  </span>
                </a>
              ))}
            </div>
          ))}
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div>
          <a className="brand" href="/">
            <BrandLogo />
            <span className="brand-name">
            DipBuyer <span className="ai">AI</span>
            <sup className="tm">™</sup>
          </span>
          </a>
          <p style={{ marginTop: 12 }}>
            A technology demonstration of an AI agent for value investing: it shows how undervalued companies can be
            identified with Peter Lynch&apos;s criteria, how overvalued ones could be flagged for sale, and the reasoning behind
            every decision.
          </p>
          <div className="social-row">
            {SOCIALS.map((s) => (
              <a key={s.href} href={s.href} target={s.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" aria-label={s.label} title={s.label}>
                {s.icon}
              </a>
            ))}
          </div>
        </div>
        {GROUPS.slice(0, 2).map((g) => (
          <div key={g.label}>
            <h4>{g.label}</h4>
            {g.items.map((i) => (
              <a key={i.href} href={i.href}>
                {i.label}
              </a>
            ))}
            {g.label === "Research" && <a href="/agent">Investing agent (demo)</a>}
          </div>
        ))}
        <div>
          <h4>Company</h4>
          <a href="/about">About</a>
          <a href="/learn">Learn</a>
          <a href="/methodology">Methodology</a>
          <a href="/portfolio">Portfolio</a>
          <a href="/onboarding">Onboarding</a>
          {GROUPS[3]!.items.map((i) => (
            <a key={i.href} href={i.href}>
              {i.label}
            </a>
          ))}
          <a href={FUND_URL} target="_blank" rel="noopener noreferrer">
            Buy The Dip Fund ↗
          </a>
        </div>
        <div>
          <h4>Contact</h4>
          <a href="mailto:hello@dipbuyer.ai">
            <IconMail /> hello@dipbuyer.ai
          </a>
          <a href="tel:+442031891661">
            <IconPhone /> +44 203 189 1661
          </a>
          <span className="footer-plain">
            <IconPin /> London, United Kingdom
          </span>
          <p className="footer-risk">
            <b>Capital at risk.</b> <BrandName /> provides research and education, not personal recommendations. The value of
            investments can fall as well as rise and you may get back less than you invest. Past performance, including
            backtested performance, is not a guide to future results.
          </p>
        </div>
      </div>
      <div className="site-footer-legal">
        <p>
          Built with <span aria-label="love">❤️</span> by{" "}
          <a href="https://www.linkedin.com/in/sergovashakmadze/" target="_blank" rel="noopener noreferrer">
            Sergo Vashakmadze
          </a>
        </p>
        <p>
          © {year} <BrandName />. All rights reserved.
        </p>
        {/* Vecteezy's free licence requires a credit in their wording, linked back to the source. */}
        <p>
          <a href="https://www.vecteezy.com/free-vector/brand" target="_blank" rel="noopener noreferrer">
            Brand Vectors by Vecteezy
          </a>{" "}
          ·{" "}
          <a href="https://www.vecteezy.com/free-photo/robot" target="_blank" rel="noopener noreferrer">
            Robot Stock photos by Vecteezy
          </a>
        </p>
      </div>
    </footer>
  );
}
