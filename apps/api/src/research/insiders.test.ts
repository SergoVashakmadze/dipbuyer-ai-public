import { describe, expect, it } from "vitest";
import { aggregateInsiders, type InsiderPurchase } from "./insiders.js";

const p = (over: Partial<InsiderPurchase>): InsiderPurchase => ({
  accession: "a1", cik: "1", ticker: "AAA", company: "Alpha Inc", filed: "2026-09-15", tradeDate: "2026-09-12",
  insider: "Jane Doe", title: "Director", isDirector: true, isOfficer: false, shares: 100, price: 10, usd: 1_000, ...over,
});

describe("aggregateInsiders", () => {
  it("merges transactions in one filing, counts distinct insiders, flags top executives", () => {
    const [a] = aggregateInsiders(
      [
        p({ accession: "a1", shares: 100, price: 10, usd: 1_000 }),
        p({ accession: "a1", shares: 100, price: 12, usd: 1_200 }), // same filing, second price
        p({ accession: "a2", insider: "John Roe", title: "CEO", isOfficer: true, isDirector: false, usd: 50_000, filed: "2026-09-16" }),
      ],
      "2026-09-01",
    );
    expect(a).toMatchObject({ ticker: "AAA", purchases: 2, insiders: 2, totalUsd: 52_200, lastFiled: "2026-09-16", topExecutiveBought: true });
    expect(a!.largest).toMatchObject({ insider: "John Roe", usd: 50_000 });
    expect(a!.recent[1]).toMatchObject({ usd: 2_200, shares: 200, price: 11 });
  });

  it("drops purchases before the window and companies below the minimum", () => {
    const rows = [p({ ticker: "OLD", filed: "2026-01-01" }), p({ ticker: "SMALL", usd: 500 }), p({ ticker: "BIG", usd: 900_000 })];
    expect(aggregateInsiders(rows, "2026-09-01", 1_000).map((c) => c.ticker)).toEqual(["BIG"]);
  });
});
