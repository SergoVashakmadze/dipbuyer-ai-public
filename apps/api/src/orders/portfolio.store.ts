import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry, PortfolioSnapshot } from "@dipbuyer/brokers";

export const LEDGER_STORE = "LEDGER_STORE";
export const SNAPSHOT_STORE = "SNAPSHOT_STORE";

/**
 * Append-only JSON-array store, optionally file-backed (atomic write, 0600). The same shape as the
 * agent-run store: in memory unless a path is configured, so tests and demos need no disk.
 */
class JsonStore<T> {
  protected items: T[] = [];
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) this.items = parsed as T[];
    } catch {
      this.items = []; // no file yet: start empty rather than refuse to boot
    }
  }
  protected persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/** Every order the app submits, with who it was for and which part of the portfolio it serves. */
export class LedgerStore extends JsonStore<LedgerEntry> {
  async record(e: LedgerEntry): Promise<void> {
    this.items.push(e);
    this.persist();
  }
  async all(): Promise<LedgerEntry[]> {
    return [...this.items];
  }
}

/** One portfolio reading per day; a later reading the same day replaces the earlier one. */
export class SnapshotStore extends JsonStore<PortfolioSnapshot> {
  async upsert(s: PortfolioSnapshot): Promise<void> {
    const i = this.items.findIndex((x) => x.date === s.date);
    if (i >= 0) this.items[i] = s;
    else this.items.push(s);
    this.persist();
  }
  async all(): Promise<PortfolioSnapshot[]> {
    return [...this.items];
  }
}

export const ledgerProvider = { provide: LEDGER_STORE, useFactory: () => new LedgerStore(process.env.PORTFOLIO_LEDGER_PATH || undefined) };
export const snapshotProvider = { provide: SNAPSHOT_STORE, useFactory: () => new SnapshotStore(process.env.PORTFOLIO_SNAPSHOTS_PATH || undefined) };
