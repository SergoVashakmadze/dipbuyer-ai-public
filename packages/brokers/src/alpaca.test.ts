import { describe, expect, it, vi } from "vitest";
import type { IntendedAction } from "@dipbuyer/shared";
import { AlpacaTradingBroker } from "./alpaca.js";

const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as Response;
const order = (o: Partial<IntendedAction> & { symbol?: string }) =>
  ({ symbol: "AAPL", side: "buy", qtyOrNotional: "10", orderType: "market", idempotencyKey: "k1", ...o }) as IntendedAction & { symbol: string };

describe("AlpacaTradingBroker", () => {
  it("uses the paper base URL by default and sends client_order_id", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "o1", client_order_id: "k1", status: "accepted" }));
    const b = new AlpacaTradingBroker({ keyId: "k", secretKey: "s", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await b.placeOrder(order({}));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("paper-api.alpaca.markets/v2/orders");
    expect(JSON.parse(init.body as string).client_order_id).toBe("k1");
    expect(r.status).toBe("accepted");
  });

  it("maps a rejected HTTP response to a rejected order", async () => {
    const b = new AlpacaTradingBroker({
      keyId: "k",
      secretKey: "s",
      fetchImpl: (async () => json({}, false, 422)) as unknown as typeof fetch,
    });
    expect((await b.placeOrder(order({}))).status).toBe("rejected");
  });

  it("reads cash from the account endpoint", async () => {
    const b = new AlpacaTradingBroker({
      keyId: "k",
      secretKey: "s",
      fetchImpl: (async () => json({ cash: "12345.67" })) as unknown as typeof fetch,
    });
    expect(await b.getCash()).toBeCloseTo(12345.67, 2);
  });

  it("targets the live URL when paper is false", async () => {
    const fetchImpl = vi.fn(async () => json({ cash: "0" }));
    const b = new AlpacaTradingBroker({ keyId: "k", secretKey: "s", paper: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    await b.getCash();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("api.alpaca.markets");
  });
});
