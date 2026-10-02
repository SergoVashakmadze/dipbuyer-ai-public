import type { DecisionRecord } from "@dipbuyer/shared";

/**
 * Persistence seam for DecisionRecords (the audit system of record). The in-memory impl is for
 * dev/tests; production swaps a Postgres/Prisma-backed store with an immutable, append-only table
 * (SYSC 5–7yr retention, the engineering design notes§11). Records are never mutated once written.
 */
export interface DecisionStore {
  save(record: DecisionRecord): Promise<void>;
  recent(limit?: number): Promise<DecisionRecord[]>;
  latestFor(symbol: string): Promise<DecisionRecord | null>;
}

export class InMemoryDecisionStore implements DecisionStore {
  private readonly items: DecisionRecord[] = [];

  async save(record: DecisionRecord): Promise<void> {
    this.items.unshift(record); // newest first
    if (this.items.length > 1000) this.items.pop();
  }

  async recent(limit = 50): Promise<DecisionRecord[]> {
    return this.items.slice(0, limit);
  }

  async latestFor(symbol: string): Promise<DecisionRecord | null> {
    return this.items.find((r) => r.symbol === symbol) ?? null;
  }
}
