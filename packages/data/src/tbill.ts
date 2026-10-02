import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 3-month Treasury bill secondary-market rate, monthly average (FRED series TB3MS, percent).
 * Vendored at vendor/fred-tb3ms.csv; source: Board of Governors of the Federal Reserve System via
 * FRED, https://fred.stlouisfed.org/series/TB3MS (US government data, public domain).
 *
 * POINT-IN-TIME: a monthly average is only known once the month ends, so the rate used at a clock
 * is the PREVIOUS calendar month's average. Using the clock's own month would peek ahead.
 */
export function defaultTbillCsvPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/fred-tb3ms.csv");
}

export function parseTbillCsv(csv: string): Map<string, number> {
  const rates = new Map<string, number>();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, value] = line.split(",");
    const v = Number(value);
    if (date && Number.isFinite(v)) rates.set(date.slice(0, 7), v);
  }
  return rates;
}

/** (clock) -> annual % known at that clock, or null when the series has no prior month. */
export function tbillRateAt(rates: Map<string, number>): (clock: string) => number | null {
  return (clock: string) => {
    const d = new Date(clock);
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    return rates.get(prev.toISOString().slice(0, 7)) ?? null;
  };
}

export function loadTbillRates(path = defaultTbillCsvPath()): (clock: string) => number | null {
  return tbillRateAt(parseTbillCsv(readFileSync(path, "utf8")));
}
