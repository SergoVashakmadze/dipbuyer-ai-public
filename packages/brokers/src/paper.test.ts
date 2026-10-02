import { describe, expect, it } from "vitest";
import type { IntendedAction } from "@dipbuyer/shared";
import { PaperBroker } from "./paper.js";

const order = (o: Partial<IntendedAction> & { symbol?: string }): IntendedAction =>
  ({ side: "buy", qtyOrNotional: "10", orderType: "market", idempotencyKey: "k1", ...o }) as IntendedAction;

const broker = () => new PaperBroker({ initialCash: 1000, priceFor: () => 10 });

describe("PaperBroker", () => {
  it("fills a buy and debits cash", async () => {
    const b = broker();
    const r = await b.placeOrder(order({ symbol: "AAA", qtyOrNotional: "10" }));
    expect(r.status).toBe("filled");
    expect(await b.getCash()).toBe(900);
    const pos = await b.getPositions();
    expect(pos[0]?.symbol).toBe("AAA");
    expect(pos[0]?.qty).toBe(10);
  });

  it("dedupes by idempotency key (never executes twice)", async () => {
    const b = broker();
    const a = order({ symbol: "AAA", qtyOrNotional: "10", idempotencyKey: "same" });
    await b.placeOrder(a);
    await b.placeOrder(a);
    expect(await b.getCash()).toBe(900); // debited once, not twice
  });

  it("rejects a buy that exceeds cash", async () => {
    const b = broker();
    const r = await b.placeOrder(order({ symbol: "AAA", qtyOrNotional: "200" })); // 200*10 = 2000 > 1000
    expect(r.status).toBe("rejected");
    expect(await b.getCash()).toBe(1000);
  });

  it("charges commission on top of the buy cost", async () => {
    const b = new PaperBroker({ initialCash: 1000, priceFor: () => 10, commissionBps: 100 }); // 1%
    const r = await b.placeOrder(order({ symbol: "AAA", qtyOrNotional: "10" })); // 100 + 1 commission
    expect(r.status).toBe("filled");
    expect(await b.getCash()).toBe(899);
  });

  it("rejects a sell with no position", async () => {
    const b = broker();
    const r = await b.placeOrder(order({ side: "sell", symbol: "AAA", qtyOrNotional: "5", idempotencyKey: "s1" }));
    expect(r.status).toBe("rejected");
  });

  it("sells from a held position and credits cash", async () => {
    const b = broker();
    await b.placeOrder(order({ symbol: "AAA", qtyOrNotional: "10", idempotencyKey: "buy" }));
    const r = await b.placeOrder(order({ side: "sell", symbol: "AAA", qtyOrNotional: "4", idempotencyKey: "sell" }));
    expect(r.status).toBe("filled");
    expect(await b.getCash()).toBe(940); // 900 + 4*10
    const pos = await b.getPositions();
    expect(pos[0]?.qty).toBe(6);
  });
});
