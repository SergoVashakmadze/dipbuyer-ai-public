import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Only block API endpoints (non-HTML, never indexable). The signed-in pages
        // (/admin, /portfolio, /onboarding, /watchlist, /digest, /suitability) are NOT
        // blocked here on purpose: a robots.txt Disallow can't deindex — it only
        // hides the page's noindex, so Google keeps them as URL-only entries
        // ("Indexed, though blocked by robots.txt"). Instead each of those routes
        // has a layout exporting `robots: { index: false }`, so Google crawls them,
        // sees noindex, and drops them cleanly.
        disallow: ["/api/"],
      },
      // AI crawlers — allow Google-Extended (Gemini grounding) per Google's AI
      // Optimization Guide. Disallow training/retrieval bots from other AI
      // vendors. Matches the rest of the portfolio (merchants.london et al).
      { userAgent: "Google-Extended", allow: "/" },
      // One group per agent rather than a single grouped block. Grouping is
      // valid robots.txt, but every other site in the portfolio uses one
      // User-agent per Disallow, and the flat form is what auditing scripts
      // expect (a grouped block reads as "allowed" to a naive line-pair check).
      ...[
        "GPTBot",
        "ChatGPT-User",
        "OAI-SearchBot",
        "ClaudeBot",
        "anthropic-ai",
        "Claude-Web",
        "CCBot",
        "PerplexityBot",
        "Perplexity-User",
        "Applebot-Extended",
        "Bytespider",
        "Amazonbot",
        "meta-externalagent",
        "FacebookBot",
        "Diffbot",
        "ImagesiftBot",
      ].map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
    sitemap: "https://dipbuyer.ai/sitemap.xml",
  };
}
