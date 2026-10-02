/**
 * Point-in-time S&P 500 membership — the survivorship-bias fix.
 *
 * A backtest universe listing companies that exist TODAY is optimistic by construction: everything
 * delisted, acquired or bankrupted during the window is structurally absent, so the strategy is
 * never given the chance to buy a name that later failed. SIVB, FRC, TWTR, ATVI and WBA are all
 * missing from such a list, and a dip-buying screen would plausibly have bought several of them.
 *
 * This reads vendored membership intervals and answers "who was in the index on date D".
 * See `vendor/NOTICE.md` for provenance, verification and the LICENCE CONSTRAINTS — in particular
 * this is a backtest INPUT and must never be surfaced through the API or the web app.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MembershipInterval {
  ticker: string;
  /** ISO date (inclusive) the ticker joined the index. */
  start: string;
  /** ISO date (EXCLUSIVE) the ticker left, or null if still a member at the snapshot. */
  end: string | null;
}

/** Default location of the vendored CSV, resolved relative to this module. */
export function defaultMembershipCsvPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/sp500-membership.csv");
}

/**
 * Parses `ticker,start_date,end_date`. A blank `end_date` means "still a member".
 * A ticker may appear MORE THAN ONCE — names get dropped and re-added (AAL was a member
 * 1996-1997 and again from 2015), so this is a list of intervals, not a map.
 */
export function parseMembershipCsv(csv: string): MembershipInterval[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.trim().toLowerCase();
  if (header !== "ticker,start_date,end_date") {
    throw new Error(
      `sp500 membership: unexpected header "${lines[0]}" — refusing to guess the schema. ` +
        `A silently misparsed universe would bias every backtest built on it.`,
    );
  }
  const out: MembershipInterval[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [ticker, start, end] = line.split(",");
    if (!ticker || !start) throw new Error(`sp500 membership: malformed row ${i + 1}: "${line}"`);
    out.push({ ticker, start, end: end ? end : null });
  }
  if (out.length === 0) throw new Error("sp500 membership: no rows parsed");
  return out;
}

/**
 * Point-in-time index membership. Construct once and reuse — the whole file is held in memory
 * (~1,300 intervals), so a lookup is cheap and does no I/O.
 */
export class Sp500Membership {
  readonly sourceId = "sp500-membership-vendored";
  private readonly intervals: MembershipInterval[];

  constructor(intervals: MembershipInterval[]) {
    this.intervals = intervals;
  }

  /** Loads the vendored CSV. Pass a path to use a different snapshot. */
  static fromFile(path: string = defaultMembershipCsvPath()): Sp500Membership {
    return new Sp500Membership(parseMembershipCsv(readFileSync(path, "utf8")));
  }

  /**
   * Tickers in the index as of `asOf` (ISO date or datetime).
   *
   * `start` is inclusive and `end` EXCLUSIVE: a name removed on 2023-03-15 was a member on the
   * 14th but not the 15th. Getting this backwards would let the engine trade a name on its
   * removal date, which is precisely the look-ahead this exists to prevent.
   */
  at(asOf: string): string[] {
    const d = asOf.slice(0, 10);
    const out: string[] = [];
    for (const iv of this.intervals) {
      if (iv.start <= d && (iv.end === null || d < iv.end)) out.push(iv.ticker);
    }
    return out.sort();
  }

  /** Every ticker ever a member — including delisted names absent from any current list. */
  allTickersEver(): string[] {
    return [...new Set(this.intervals.map((i) => i.ticker))].sort();
  }

  /**
   * Latest date the snapshot can speak to: the newest interval boundary. Querying beyond this
   * returns the current members by construction, which would silently look like a valid answer
   * for a future date. Callers should refuse to run past it.
   */
  snapshotThrough(): string {
    let max = "";
    for (const iv of this.intervals) {
      if (iv.start > max) max = iv.start;
      if (iv.end && iv.end > max) max = iv.end;
    }
    return max;
  }
}
