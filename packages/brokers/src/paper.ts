import type { IntendedAction } from "@dipbuyer/shared";
import type { IBroker, OrderResult, Position } from "./index.js";

/**
 * Deterministic in-memory paper broker. No network. Enforces the money-safety invariant that
 * every order carries a unique idempotency key (duplicate keys are deduped, not re-executed).
 * Used for Phase 3 paper execution and as the default backtest fill engine.
 */
export class PaperBroker implements IBroker {
  readonly id = "paper" as const;
  private cash: number;
  private readonly positions = new Map<string, Position>();
  private readonly seenKeys = new Map<string, OrderResult>();

  constructor(opts: { initialCash: number; priceFor: (symbol: string) => number; commissionBps?: number }) {
    this.cash = opts.initialCash;
    this.priceFor = opts.priceFor;
    this.commissionBps = opts.commissionBps ?? 0;
  }

  private readonly priceFor: (symbol: string) => number;
  private readonly commissionBps: number;

  async placeOrder(action: IntendedAction): Promise<OrderResult> {
    // Idempotency: same key never executes twice.
    const existing = this.seenKeys.get(action.idempotencyKey);
    if (existing) return existing;

    const symbol = (action as IntendedAction & { symbol?: string }).symbol ?? "UNKNOWN";
    const price = action.orderType === "limit" && action.limitPrice ? Number(action.limitPrice) : this.priceFor(symbol);
    const qty = Number(action.qtyOrNotional);
    const cost = qty * price;
    const commission = (cost * this.commissionBps) / 10_000;

    let status: OrderResult["status"] = "filled";
    if (action.side === "buy") {
      if (cost + commission > this.cash) status = "rejected"; // must afford shares + commission
      else {
        this.cash -= cost + commission;
        this.upsertPosition(symbol, qty, price);
      }
    } else {
      const pos = this.positions.get(symbol);
      if (!pos || pos.qty < qty) status = "rejected";
      else {
        this.cash += cost - commission; // commission reduces proceeds
        this.upsertPosition(symbol, -qty, price);
      }
    }

    const result: OrderResult = {
      brokerOrderId: `paper-${this.seenKeys.size + 1}`,
      clientOrderId: action.idempotencyKey,
      status,
      filledQty: status === "filled" ? qty : 0,
      filledAvgPrice: status === "filled" ? price : undefined,
    };
    this.seenKeys.set(action.idempotencyKey, result);
    return result;
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.qty !== 0);
  }

  async getCash(): Promise<number> {
    return this.cash;
  }

  /** Interest credited on idle cash (backtest cash policy). Not an order; no idempotency key. */
  creditCash(amount: number): void {
    if (Number.isFinite(amount) && amount > 0) this.cash += amount;
  }

  private upsertPosition(symbol: string, deltaQty: number, price: number): void {
    const cur = this.positions.get(symbol);
    if (!cur) {
      this.positions.set(symbol, {
        symbol,
        qty: deltaQty,
        avgEntryPrice: price,
        marketValue: deltaQty * price,
        unrealizedPl: 0,
      });
      return;
    }
    const newQty = cur.qty + deltaQty;
    // Weighted avg only when adding in the same direction; reduce keeps prior avg.
    const avg = deltaQty > 0 ? (cur.avgEntryPrice * cur.qty + price * deltaQty) / Math.max(newQty, 1e-9) : cur.avgEntryPrice;
    this.positions.set(symbol, {
      symbol,
      qty: newQty,
      avgEntryPrice: avg,
      marketValue: newQty * price,
      unrealizedPl: (price - avg) * newQty,
    });
  }
}
