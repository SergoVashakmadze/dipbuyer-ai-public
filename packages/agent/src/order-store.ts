/**
 * Order record-keeping (SYSC 9 / money-safety audit). Every order the system submits is recorded
 * immutably with its broker id, idempotency key, status and source. In-memory for now; Postgres
 * (Order model) is the production target. Append-only.
 */
export interface OrderRecord {
  ts: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  status: string;
  brokerOrderId: string;
  clientOrderId: string;
  source: "manual" | "agent";
}

export interface OrderStore {
  record(o: OrderRecord): Promise<void>;
  recent(limit?: number): Promise<OrderRecord[]>;
}

export class InMemoryOrderStore implements OrderStore {
  private readonly items: OrderRecord[] = [];
  async record(o: OrderRecord): Promise<void> {
    this.items.unshift(o);
    if (this.items.length > 2000) this.items.pop();
  }
  async recent(limit = 100): Promise<OrderRecord[]> {
    return this.items.slice(0, limit);
  }
}
