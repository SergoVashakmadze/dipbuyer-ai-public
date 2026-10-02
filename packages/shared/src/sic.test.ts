import { describe, expect, it } from "vitest";
import { isDebtGateExempt, sectorForSic } from "./sic.js";

describe("sectorForSic", () => {
  it("maps real SIC codes verified live against data.sec.gov", () => {
    expect(sectorForSic("6021")).toBe("financials"); // BAC / JPM — "National Commercial Banks"
    expect(sectorForSic("2834")).toBe("chemicals_pharma"); // pharma preparations
    expect(sectorForSic("4911")).toBe("utilities"); // electric services
    expect(sectorForSic("5812")).toBe("retail"); // eating places
    expect(sectorForSic("3711")).toBe("transport_equipment"); // motor vehicles
  });

  it("keeps mega-cap tech in ONE bucket despite SIC scattering it across three major groups", () => {
    // Raw SIC files AAPL under machinery (35) and MSFT/GOOGL under business services (73). Since
    // mega-cap tech is precisely the concentration the 30% cap exists to limit, that scattering
    // would defeat the control while still looking like it applied.
    expect(sectorForSic("3571")).toBe("technology"); // AAPL — "Electronic Computers"
    expect(sectorForSic("3674")).toBe("technology"); // NVDA / INTC / AMD — semiconductors
    expect(sectorForSic("7372")).toBe("technology"); // MSFT — prepackaged software
    expect(sectorForSic("7370")).toBe("technology"); // GOOGL / META — services-computer programming
    // ...and the surrounding ranges are NOT swept in with them.
    expect(sectorForSic("3569")).toBe("industrials");
    expect(sectorForSic("7380")).toBe("services");
  });

  it("accepts the numeric form the submissions document sometimes returns", () => {
    expect(sectorForSic(6021)).toBe("financials");
  });

  it("returns null for missing or unparseable codes rather than guessing a sector", () => {
    // Null must mean "unclassified" all the way through: sectorHeadroom treats it as uncapped,
    // so a wrong guess here would cap the wrong book.
    expect(sectorForSic(null)).toBeNull();
    expect(sectorForSic(undefined)).toBeNull();
    expect(sectorForSic("")).toBeNull();
    expect(sectorForSic("not-a-code")).toBeNull();
    expect(sectorForSic("0")).toBeNull();
    expect(sectorForSic("99999")).toBeNull();
  });
});

describe("isDebtGateExempt", () => {
  it("exempts finance, insurance and real estate (6000-6799)", () => {
    // Lynch exempted financials explicitly; Fannie Mae (>10:1 leverage) was his biggest winner.
    expect(isDebtGateExempt("6021")).toBe(true); // national commercial banks — BAC, JPM
    expect(isDebtGateExempt("6035")).toBe(true); // savings institutions — the S&L chapter
    expect(isDebtGateExempt("6111")).toBe(true); // federal credit agencies — Fannie Mae
    expect(isDebtGateExempt("6798")).toBe(true); // REITs
    expect(isDebtGateExempt("6000")).toBe(true);
    expect(isDebtGateExempt("6799")).toBe(true);
  });

  it("exempts utilities (4900-4949)", () => {
    expect(isDebtGateExempt("4911")).toBe(true);
    expect(isDebtGateExempt("4931")).toBe(true);
    expect(isDebtGateExempt("4949")).toBe(true);
  });

  it("does NOT exempt operating companies, including adjacent SIC ranges", () => {
    expect(isDebtGateExempt("3571")).toBe(false); // AAPL
    expect(isDebtGateExempt("4899")).toBe(false); // communications, just below utilities
    expect(isDebtGateExempt("4950")).toBe(false); // sanitary services, just above
    expect(isDebtGateExempt("5999")).toBe(false); // retail, just below financials
    expect(isDebtGateExempt("6800")).toBe(false); // just above financials
  });

  it("does NOT exempt an unknown SIC", () => {
    // Fail CLOSED. Exempting everything we could not classify would delete the gate rather than
    // scope it — and non-EDGAR sources carry no SIC at all.
    expect(isDebtGateExempt(null)).toBe(false);
    expect(isDebtGateExempt(undefined)).toBe(false);
    expect(isDebtGateExempt("")).toBe(false);
  });
});
