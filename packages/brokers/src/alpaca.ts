import type { IntendedAction } from "@dipbuyer/shared";
import type { IBroker, OrderResult, Position } from "./index.js";

/**
 * Alpaca Trading API broker (single account; paper or live). Use the PAPER environment for the
 * MVP — same API surface as live, just a different base URL + keys. This is NOT the Broker API
 * (that's for opening/KYC/funding many end-user accounts, i.e. the white-label channel later).
 *
 * Money-safety: every order sends `client_order_id = idempotencyKey` so Alpaca dedups replays.
 * `fetch` is injectable for testing.
 */
export interface AlpacaTradingOptions {
  keyId: string;
  secretKey: string;
  paper?: boolean; // default true
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AlpacaOrder {
  id: string;
  client_order_id: string;
  status: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
}
interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

const STATUS_MAP: Record<string, OrderResult["status"]> = {
  filled: "filled",
  partially_filled: "partially_filled",
  accepted: "accepted",
  new: "accepted",
  pending_new: "accepted",
  canceled: "canceled",
  rejected: "rejected",
};

export class AlpacaTradingBroker implements IBroker {
  readonly id: "alpaca-us" = "alpaca-us";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AlpacaTradingOptions) {
    const paper = opts.paper ?? true;
    this.baseUrl = opts.baseUrl ?? (paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.opts.keyId,
      "APCA-API-SECRET-KEY": this.opts.secretKey,
      "Content-Type": "application/json",
    };
  }

  async placeOrder(action: IntendedAction & { symbol?: string }): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol: action.symbol,
      side: action.side,
      type: action.orderType === "bracket" ? "market" : action.orderType,
      time_in_force: "day",
      client_order_id: action.idempotencyKey,
    };
    // Notional vs qty: a decimal-ish quantity stays qty; callers pass share count here.
    body["qty"] = action.qtyOrNotional;
    if (action.limitPrice) body["limit_price"] = action.limitPrice;

    const res = await this.fetchImpl(`${this.baseUrl}/v2/orders`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        brokerOrderId: "",
        clientOrderId: action.idempotencyKey,
        status: "rejected",
      };
    }
    const o = (await res.json()) as AlpacaOrder;
    return {
      brokerOrderId: o.id,
      clientOrderId: o.client_order_id,
      status: STATUS_MAP[o.status] ?? "accepted",
      filledQty: o.filled_qty ? Number(o.filled_qty) : undefined,
      filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : undefined,
    };
  }

  async getPositions(): Promise<Position[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/positions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`alpaca positions: HTTP ${res.status}`);
    const rows = (await res.json()) as AlpacaPosition[];
    return rows.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      marketValue: Number(p.market_value),
      unrealizedPl: Number(p.unrealized_pl),
    }));
  }

  async getCash(): Promise<number> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/account`, { headers: this.headers() });
    if (!res.ok) throw new Error(`alpaca account: HTTP ${res.status}`);
    const acct = (await res.json()) as { cash: string };
    return Number(acct.cash);
  }
}
