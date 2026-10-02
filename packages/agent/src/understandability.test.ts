import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import type { Fundamentals } from "@dipbuyer/shared";
import { createLlmUnderstandabilityProvider } from "./understandability.js";

const f = { symbol: "AAPL", asOf: "2026-01-01T00:00:00Z", peRatio: 12, epsGrowthPct: 25 } as Fundamentals;

/** Minimal stub of the OpenAI-compatible client — only chat.completions.create is exercised. */
function stubClient(create: () => Promise<unknown>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

const completion = (content: string | null) => ({ choices: [{ message: { content } }] });

describe("createLlmUnderstandabilityProvider", () => {
  it("parses a clean JSON narrative from the model", async () => {
    const client = stubClient(async () =>
      completion('{"passed":true,"businessSummary":"Makes phones.","growthStory":"Services growth."}'),
    );
    const provider = createLlmUnderstandabilityProvider({ apiKey: "test", client });
    const u = await provider("AAPL", f);
    expect(u).toEqual({ passed: true, businessSummary: "Makes phones.", growthStory: "Services growth." });
  });

  it("extracts JSON even when wrapped in a code fence and prose", async () => {
    const client = stubClient(async () =>
      completion('Here you go:\n```json\n{"passed":false,"businessSummary":"Opaque.","growthStory":"Cyclical."}\n```'),
    );
    const provider = createLlmUnderstandabilityProvider({ apiKey: "test", client });
    const u = await provider("XYZ", f);
    expect(u.passed).toBe(false);
    expect(u.businessSummary).toBe("Opaque.");
  });

  it("falls back permissively when the API call throws", async () => {
    const client = stubClient(async () => {
      throw new Error("network down");
    });
    const provider = createLlmUnderstandabilityProvider({ apiKey: "test", client });
    const u = await provider("AAPL", f);
    expect(u.passed).toBe(true); // never blocks the deterministic verdict
    expect(u.businessSummary).toContain("network down");
  });

  it("falls back when the model returns empty content", async () => {
    const client = stubClient(async () => completion(null));
    const provider = createLlmUnderstandabilityProvider({ apiKey: "test", client });
    const u = await provider("AAPL", f);
    expect(u.passed).toBe(true);
    expect(u.businessSummary).toContain("no narrative returned");
  });
});
