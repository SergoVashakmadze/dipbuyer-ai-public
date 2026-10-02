import { describe, expect, it } from "vitest";
import { loadTbillRates, parseTbillCsv, tbillRateAt } from "./tbill.js";

describe("T-bill rates", () => {
  it("uses the previous month's average at a clock, never the current month", () => {
    const at = tbillRateAt(parseTbillCsv("observation_date,TB3MS\n2026-01-01,4.00\n2026-02-01,9.99\n"));
    expect(at("2026-02-28T00:00:00Z")).toBe(4);
    expect(at("2026-01-31T00:00:00Z")).toBeNull();
  });

  it("loads the vendored FRED series", () => {
    const at = loadTbillRates();
    expect(at("2020-05-01T00:00:00Z")).toBeLessThan(0.5); // Apr 2020, ZIRP
    expect(at("2024-01-15T00:00:00Z")).toBeGreaterThan(5); // Dec 2023
  });
});
