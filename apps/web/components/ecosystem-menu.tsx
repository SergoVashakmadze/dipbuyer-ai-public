"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevron } from "./icons";

// Ecosystem domains - must be identical across all IoMarkets domains
const ECOSYSTEM = [
  { name: "IoMarkets.org", subtitle: "Organization", url: "https://iomarkets.org", icon: "🏛️" },
  { name: "IoMarkets.io", subtitle: "AI-Native Web3 Capital Markets", url: "https://iomarkets.io", icon: "📈" },
  { name: "IoMarkets.money", subtitle: "Digital Money, Stablecoins & Payments", url: "https://iomarkets.money", icon: "💰" },
  { name: "IoMarkets.app", subtitle: "Real-World Checkout for AI Agents", url: "https://iomarkets.app", icon: "🛒" },
  { name: "IoMarkets.xyz", subtitle: "Digital Collectibles & NFT Platform", url: "https://iomarkets.xyz", icon: "🎨" },
  { name: "IoMarkets.pro", subtitle: "Universal Exchange - Pro Trading Suite", url: "https://iomarkets.pro", icon: "💹" },
  { name: "IoMarkets.ai", subtitle: "AI-Powered Markets Intelligence", url: "https://iomarkets.ai", icon: "🤖" },
  { name: "IoMarkets.co", subtitle: "Corporate Finance & Investor Relations", url: "https://iomarkets.co", icon: "🏢" },
  { name: "IoMarkets.vc", subtitle: "Venture Capital Investment Fund", url: "https://iomarkets.vc", icon: "🚀" },
  { name: "IoMarkets.fund", subtitle: "Asset Management", url: "https://iomarkets.fund", icon: "📊" },
  { name: "IoMarkets.tv", subtitle: "Global Financial News Television", url: "https://iomarkets.tv", icon: "📺" },
  { name: "IoMarkets.news", subtitle: "Global Online Financial News", url: "https://iomarkets.news", icon: "📰" },
  { name: "IoMarkets.tech", subtitle: "Financial Technology Solutions", url: "https://iomarkets.tech", icon: "⚙️" },
  { name: "DipBuyer AI™", subtitle: "AI Agent for Value Investing", url: "https://dipbuyer.ai", icon: "🎯", current: true },
  { name: "Merchants of London", subtitle: "Merchant Bank & MFO", url: "https://merchants.london", icon: "🏦" },
];

/**
 * The IoMarkets® ecosystem pill and dropdown, matching iomarkets.org's header in size, colours and
 * behaviour. It stays slate/amber in both themes: that is the spec shared by every sibling site.
 * Styles are the `.eco-*` rules in globals.css.
 */
export function EcosystemMenu({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={mobile ? "eco eco-mobile" : "eco eco-desktop"}>
      <button type="button" className="eco-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {mobile ? "Ecosystem" : "IoMarkets Ecosystem"}
        {!mobile && <IconChevron className={open ? "open" : undefined} />}
      </button>
      {open && (
        <div className="eco-panel" role="menu">
          {ECOSYSTEM.map((d) => (
            <a
              key={d.name}
              role="menuitem"
              href={d.current ? "/" : d.url}
              target={d.current ? undefined : "_blank"}
              rel={d.current ? undefined : "noopener noreferrer"}
              onClick={() => setOpen(false)}
              className={d.current ? "eco-item cur" : "eco-item"}
            >
              <span className="eco-icon">{d.icon}</span>
              <span className="eco-text">
                <b>{d.name}</b>
                <small>{d.subtitle}</small>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
