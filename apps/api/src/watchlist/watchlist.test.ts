import { describe, expect, it } from "vitest";
import { WatchlistController, WatchlistService, WatchlistStore } from "./watchlist.js";
import type { ResearchService } from "../research/research.service.js";

/** Research fake whose verdict and drawdown the test moves between checks. */
function fakeResearch(state: { verdict: string; drawdown: number }) {
  return {
    view: async () => ({
      decision: { record: { verdict: state.verdict, convictionScore: 72 } },
      price: { price: 80, drawdown: state.drawdown },
    }),
  } as unknown as ResearchService;
}

describe("WatchlistService", () => {
  it("baselines on add, then alerts once per change", async () => {
    process.env.INSIDER_RECENT_PATH = "/nonexistent/insider-recent.json";
    const state = { verdict: "hold", drawdown: 0.05 };
    const svc = new WatchlistService(new WatchlistStore(), fakeResearch(state));
    const ctrl = new WatchlistController(svc);
    await ctrl.add("ko", {});
    expect((await ctrl.list()).unread).toBe(0); // baseline only

    state.verdict = "buy";
    state.drawdown = 0.2;
    await ctrl.checkNow();
    const alerts = ctrl.alerts();
    expect(alerts.map((a) => a.kind).sort()).toEqual(["buy_verdict", "dip"]);
    expect(alerts.find((a) => a.kind === "dip")!.message).toMatch(/KO is 20% below its 52-week high/);

    await ctrl.checkNow(); // no further change, no new alerts
    expect(ctrl.alerts()).toHaveLength(2);
    ctrl.read();
    expect((await ctrl.list()).unread).toBe(0);
  });

  it("validates symbols and dip thresholds", async () => {
    const ctrl = new WatchlistController(new WatchlistService(new WatchlistStore(), fakeResearch({ verdict: "hold", drawdown: 0 })));
    await expect(ctrl.add("not a ticker", {})).rejects.toThrow(/Invalid symbol/);
    await expect(ctrl.add("KO", { dipPct: 150 })).rejects.toThrow(/between 0 and 100/);
  });
});
