import { describe, expect, it } from "vitest";
import { composeDigest, type DigestInput } from "./compose.js";

const base: DigestInput = {
  name: "Jane Investor",
  weekEnding: "2026-09-18",
  appUrl: "https://dipbuyer.ai",
  portfolio: { equity: 100_004, cash: 2_000, positions: 3, unrealized: 4 },
  agent: { runs: 1, ordersPlaced: 3, lastRunAt: "2026-09-18T10:00:00Z" },
  alerts: [{ symbol: "FOXA", kind: "insider_buy", message: "Insider buying at FOXA: CEO bought $10.3M.", at: "2026-09-18T10:00:00Z" }],
  buys: [{ symbol: "NVDA", convictionScore: 78, upside: 0.2, drawdown: 0.12 }],
  insiders: [{ ticker: "COO", company: "Cooper Companies", totalUsd: 1_900_000, insiders: 3, topExecutiveBought: false }],
};

describe("composeDigest", () => {
  it("builds subject, text and HTML with every section and the required footer", () => {
    const d = composeDigest(base);
    expect(d.subject).toBe("DipBuyer weekly: 1 watchlist alert (week to 2026-09-18)");
    expect(d.text).toContain("Hi Jane,");
    expect(d.text).toContain("- NVDA: Lynch buy, conviction 78/100, 12% below its 52-week high, 20% below intrinsic value");
    expect(d.text).toContain("- COO (Cooper Companies): $1.9M by 3 insiders");
    const above = composeDigest({ ...base, buys: [{ symbol: "NVDA", convictionScore: 95, upside: -0.34, drawdown: 0.07 }], insiders: [{ ...base.insiders[0]!, company: "COOPER COMPANIES, INC." }] });
    expect(above.text).toContain("34% above intrinsic value");
    expect(above.text).toContain("COO (Cooper Companies, Inc.)");
    expect(d.text).toMatch(/not a personal recommendation\. Capital at risk/);
    expect(d.html).toContain('href="https://dipbuyer.ai/stock/NVDA"');
    expect(d.html).toContain("Manage the digest");
  });

  it("escapes HTML in content and says so when nothing happened", () => {
    const quiet = composeDigest({ ...base, portfolio: null, agent: null, alerts: [], buys: [], insiders: [] });
    expect(quiet.text).toContain("A quiet week");
    const evil = composeDigest({ ...base, alerts: [{ ...base.alerts[0]!, message: "<script>x</script>" }] });
    expect(evil.html).not.toContain("<script>");
    expect(evil.html).toContain("&lt;script&gt;");
  });
});
