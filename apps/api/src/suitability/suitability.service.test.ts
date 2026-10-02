import { describe, expect, it } from "vitest";
import { SuitabilityService, type SuitabilityInput } from "./suitability.service.js";

const input = (over: Partial<SuitabilityInput> = {}): SuitabilityInput => ({
  userId: "u1",
  objectives: "long-term growth",
  riskTolerance: "medium",
  capacityForLoss: "medium",
  knowledgeExperience: "informed",
  ...over,
});

describe("SuitabilityService (COBS 9A)", () => {
  it("assess() persists a VALID record with a timestamp and defaulted exclusions", () => {
    const svc = new SuitabilityService();
    const rec = svc.assess(input());
    expect(rec.status).toBe("VALID");
    expect(rec.exclusions).toEqual([]);
    expect(() => new Date(rec.assessedAt).toISOString()).not.toThrow();
    expect(svc.get("u1")).toEqual(rec);
  });

  it("preserves supplied exclusions", () => {
    const svc = new SuitabilityService();
    const rec = svc.assess(input({ exclusions: ["tobacco", "defence"] }));
    expect(rec.exclusions).toEqual(["tobacco", "defence"]);
  });

  it("isValid() is false until assessed, true after, and get() is null for unknown users", () => {
    const svc = new SuitabilityService();
    expect(svc.isValid("u1")).toBe(false);
    expect(svc.get("u1")).toBeNull();
    svc.assess(input());
    expect(svc.isValid("u1")).toBe(true);
    expect(svc.isValid("other")).toBe(false);
  });
});
