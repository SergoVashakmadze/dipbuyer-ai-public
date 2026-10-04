import type { MetadataRoute } from "next";

// Public pages only. Signed-in pages are noindex (see robots.ts); /autopilot
// redirects to /agent; /stock/[symbol] and /decision/[symbol] are per-ticker.
const PAGES: Array<[path: string, changeFrequency: "hourly" | "daily" | "weekly" | "monthly", priority: number]> = [
  ["/", "daily", 1],
  ["/news", "hourly", 0.9],
  ["/opportunities", "daily", 0.9],
  ["/markets", "daily", 0.8],
  ["/insiders", "daily", 0.8],
  ["/agent", "weekly", 0.8],
  ["/tools/fair-value", "weekly", 0.8],
  ["/learn", "weekly", 0.8],
  ["/methodology", "monthly", 0.7],
  ["/backtest", "monthly", 0.7],
  ["/models", "weekly", 0.7],
  ["/about", "monthly", 0.7],
  ["/audit", "daily", 0.6],
  ["/monad", "monthly", 0.6],
  ["/verify", "monthly", 0.5],
  ["/verify/monad", "monthly", 0.5],
  ["/reports", "monthly", 0.5],
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGES.map(([path, changeFrequency, priority]) => ({
    url: `https://dipbuyer.ai${path === "/" ? "/" : path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
