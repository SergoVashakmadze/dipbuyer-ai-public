import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Sp500Membership, defaultMembershipCsvPath, parseMembershipCsv } from "./sp500-membership.js";

// The vendored file is not published with the open-source copy (see vendor/README.md); these tests need it.
const haveCsv = existsSync(defaultMembershipCsvPath());

/**
 * These assert against REAL index history, not fixtures of our own invention. The five 2026-07-19
 * data bugs all passed a unit suite whose mocks encoded our assumptions about a source rather than
 * its behaviour — so a universe test that only proves "the parser round-trips what we wrote" would
 * be worth nothing. Every date below is a checkable public event.
 */
describe.skipIf(!haveCsv)("Sp500Membership — vendored point-in-time index membership", () => {
  // describe-body setup runs even when the suite is skipped, so only read the file if it exists.
  const m = haveCsv ? Sp500Membership.fromFile() : (undefined as unknown as Sp500Membership);

  it("reproduces known member counts (499-505, NOT exactly 500)", () => {
    // The index holds ~500 CONSTITUENTS but the count drifts with pending adds/removes and
    // multiple share classes. An implementation returning exactly 500 would be suspicious.
    for (const [date, n] of [["2015-06-30", 499], ["2020-03-16", 505], ["2024-06-28", 503]] as const) {
      expect(m.at(date).length, `members at ${date}`).toBe(n);
    }
  });

  it("includes names that no longer exist — the entire point of the fix", () => {
    // Each of these is absent from any list of companies that exist today, and each is exactly the
    // kind of name a dip-buying screen would have been tempted by on the way down.
    const members2020 = new Set(m.at("2020-03-16"));
    for (const dead of ["SIVB", "FRC", "TWTR", "ATVI", "WBA"]) {
      expect(members2020.has(dead), `${dead} should be a member on 2020-03-16`).toBe(true);
    }
  });

  it("drops names on the real dates they left the index", () => {
    // SVB failed 2023-03-15 and First Republic 2023-05-04. A universe still holding them after
    // those dates would let the backtest trade a company that had ceased to exist.
    expect(m.at("2023-03-14")).toContain("SIVB");
    expect(m.at("2023-03-15")).not.toContain("SIVB");
    expect(m.at("2023-05-03")).toContain("FRC");
    expect(m.at("2023-05-04")).not.toContain("FRC");
  });

  it("treats end_date as EXCLUSIVE and start_date as INCLUSIVE", () => {
    // Off-by-one here is look-ahead: trading a name on its removal date, or missing its first day.
    // ATVI joined 2015-08-31 and left 2023-10-18.
    expect(m.at("2015-08-30")).not.toContain("ATVI");
    expect(m.at("2015-08-31")).toContain("ATVI");
    expect(m.at("2023-10-17")).toContain("ATVI");
    expect(m.at("2023-10-18")).not.toContain("ATVI");
  });

  it("handles a ticker with MULTIPLE membership spells", () => {
    // AAL was a member 1996-1997, dropped, then re-added in 2015. Collapsing intervals into a
    // single start/end per ticker would wrongly make it a member for the ~18 years in between.
    expect(m.at("1996-06-01")).toContain("AAL");
    expect(m.at("2005-06-01")).not.toContain("AAL");
    expect(m.at("2016-06-01")).toContain("AAL");
  });

  it("knows more tickers than are currently members", () => {
    const ever = m.allTickersEver().length;
    const now = m.at(m.snapshotThrough()).length;
    expect(ever).toBeGreaterThan(now * 2); // ~1,200 ever vs ~500 now
  });

  it("accepts a datetime clock, not just a date", () => {
    // The backtest schedule supplies ISO datetimes.
    expect(m.at("2020-03-16T00:00:00Z")).toEqual(m.at("2020-03-16"));
  });

  it("refuses an unexpected schema rather than guessing", () => {
    // Silently misparsing the universe would bias every backtest built on it, with no symptom.
    expect(() => parseMembershipCsv("symbol,from,to\nAAA,2020-01-01,")).toThrow(/unexpected header/);
  });

  it("parses a blank end_date as still-a-member", () => {
    const parsed = parseMembershipCsv("ticker,start_date,end_date\nAAA,2020-01-01,\n");
    expect(parsed[0]!.end).toBeNull();
  });
});
