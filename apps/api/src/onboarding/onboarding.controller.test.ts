import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvestorStore } from "../investors/investor.store.js";
import { KycService } from "../kyc/kyc.service.js";
import { MockKycProvider } from "../kyc/kyc.provider.js";
import { SuitabilityService } from "../suitability/suitability.service.js";
import { OnboardingController } from "./onboarding.controller.js";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AUTH0_DOMAIN: process.env.AUTH0_DOMAIN, AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE };
  delete process.env.AUTH0_DOMAIN;
  delete process.env.AUTH0_AUDIENCE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setup() {
  const store = new InvestorStore();
  const kyc = new KycService(store, new MockKycProvider());
  const suitability = new SuitabilityService(store);
  return { store, kyc, suitability, ctrl: new OnboardingController(store, kyc, suitability) };
}
const me = { user: { sub: "auth0|me", email: "me@example.com" } };
const answers = { objectives: "Long-term growth", riskTolerance: "medium", capacityForLoss: "medium", knowledgeExperience: "informed", investmentHorizon: "5to10" } as const;

describe("OnboardingController", () => {
  it("walks profile -> identity -> suitability to complete, in order", async () => {
    const { ctrl, kyc, suitability } = setup();
    expect(await ctrl.me(me)).toMatchObject({ userId: "auth0|me", email: "me@example.com", complete: false, steps: { profile: "todo", identity: "todo", suitability: "todo" } });
    await expect(ctrl.startIdentity(me)).rejects.toThrow(/details first/);
    expect(() => ctrl.assess(answers, me)).toThrow(/Verify your identity/);
    ctrl.profile({ fullName: "Ada Lovelace", countryOfResidence: "gb" }, me);
    const afterId = await ctrl.startIdentity(me);
    expect(afterId.steps.identity).toBe("done");
    expect(afterId.identityProvider).toEqual({ name: "mock", demo: true });
    const done = ctrl.assess(answers, me);
    expect(done.complete).toBe(true);
    expect(done.profile).toEqual({ fullName: "Ada Lovelace", countryOfResidence: "GB" });
    expect(kyc.isValid("auth0|me") && suitability.isValid("auth0|me")).toBe(true);
  });

  it("validates the profile", () => {
    const { ctrl } = setup();
    expect(() => ctrl.profile({ fullName: "A", countryOfResidence: "GB" }, me)).toThrow(/full legal name/);
    expect(() => ctrl.profile({ fullName: "Ada Lovelace", countryOfResidence: "Britain" }, me)).toThrow(/country/);
  });

  it("warns (does not block) on low risk tolerance, and requires an explicit acknowledgement", async () => {
    const { ctrl, suitability } = setup();
    ctrl.profile({ fullName: "Ada Lovelace", countryOfResidence: "GB" }, me);
    await ctrl.startIdentity(me);
    const cautious = { ...answers, riskTolerance: "low" as const };
    expect(() => ctrl.assess(cautious, me)).toThrow(/confirm you understand/);
    const out = ctrl.assess({ ...cautious, riskAcknowledged: true }, me);
    expect(out.complete).toBe(true);
    expect(out.suitability!.warnings).toHaveLength(1);
    expect(out.suitability!.riskAcknowledgedAt).not.toBeNull();
    expect(suitability.isValid("auth0|me")).toBe(true);
  });

  it("records an unsuitable outcome with reasons, and it blocks trading", async () => {
    const { ctrl, suitability } = setup();
    ctrl.profile({ fullName: "Ada Lovelace", countryOfResidence: "GB" }, me);
    await ctrl.startIdentity(me);
    const out = ctrl.assess({ ...answers, capacityForLoss: "low", investmentHorizon: "lt3" }, me);
    expect(out.steps.suitability).toBe("unsuitable");
    expect(out.complete).toBe(false);
    expect(out.suitability!.reasons).toHaveLength(2);
    expect(suitability.isValid("auth0|me")).toBe(false);
  });
});
