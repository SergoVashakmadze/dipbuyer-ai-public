import { createHmac } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestorStore } from "../investors/investor.store.js";
import { KycService } from "./kyc.service.js";
import { KycController } from "./kyc.controller.js";
import { buildKycProvider, mapPersonaStatus, MockKycProvider, PersonaKycProvider } from "./kyc.provider.js";

const ENV = ["KYC_PROVIDER", "PERSONA_API_KEY", "PERSONA_TEMPLATE_ID", "PERSONA_WEBHOOK_SECRET", "AUTH0_DOMAIN", "AUTH0_AUDIENCE"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function personaFetch(opts: { status?: string; linkOk?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/inquiries") && init?.method === "POST") return json({ data: { id: "inq_123" } });
    if (url.endsWith("/generate-one-time-link")) return opts.linkOk === false ? json({}, 500) : json({ meta: { "one-time-link": "https://withpersona.com/verify?code=abc" } });
    if (url.endsWith("/inquiries/inq_123")) return json({ data: { attributes: { status: opts.status ?? "approved" } } });
    return json({}, 404);
  });
}

const persona = (fetchImpl: typeof fetch, webhookSecret: string | null = "whsec") =>
  new PersonaKycProvider({ apiKey: "key", templateId: "itmpl_1", webhookSecret: webhookSecret ?? undefined, fetchImpl });

const sign = (body: string, secret = "whsec", t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const event = (status: string, name = "inquiry.approved") => JSON.stringify({ data: { attributes: { name, payload: { data: { id: "inq_123", attributes: { status } } } } } });

describe("provider selection", () => {
  it("uses the demo mock with no Persona keys, Persona when keys exist, and KYC_PROVIDER overrides", () => {
    expect(buildKycProvider()).toBeInstanceOf(MockKycProvider);
    process.env.PERSONA_API_KEY = "k";
    process.env.PERSONA_TEMPLATE_ID = "t";
    expect(buildKycProvider().name).toBe("persona");
    process.env.KYC_PROVIDER = "mock";
    expect(buildKycProvider().demo).toBe(true);
  });

  it("only an explicit Persona approval unlocks trading", () => {
    expect(mapPersonaStatus("approved").status).toBe("VALID");
    expect(mapPersonaStatus("completed").status).toBe("PENDING");
    expect(mapPersonaStatus("needs_review")).toEqual({ status: "PENDING", detail: "Persona: needs review" });
    expect(mapPersonaStatus("declined").status).toBe("REJECTED");
  });
});

describe("KycService", () => {
  it("is PENDING before verification and VALID after the demo mock, labelled demo", async () => {
    const svc = new KycService(new InvestorStore(), new MockKycProvider());
    expect(svc.isValid("u1")).toBe(false);
    const r = await svc.start("u1");
    expect(r).toMatchObject({ status: "VALID", provider: "mock", demo: true });
    expect(svc.isValid("u1")).toBe(true);
    expect(svc.isValid("other")).toBe(false);
  });

  it("survives a restart when the store is file-backed, with owner-only permissions", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "inv-")), "investors.json");
    await new KycService(new InvestorStore(path), new MockKycProvider()).start("u1");
    expect(new KycService(new InvestorStore(path), new MockKycProvider()).isValid("u1")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("Persona: creates an inquiry for the user and returns a hosted link, pending until approved", async () => {
    const f = personaFetch({ status: "needs_review" });
    const svc = new KycService(new InvestorStore(), persona(f as unknown as typeof fetch));
    const started = await svc.start("auth0|abc");
    expect(started).toMatchObject({ status: "PENDING", inquiryId: "inq_123", hostedUrl: "https://withpersona.com/verify?code=abc", demo: false });
    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
    expect(body.data.attributes).toEqual({ "inquiry-template-id": "itmpl_1", "reference-id": "auth0|abc" });
    expect((await svc.refresh("auth0|abc")).status).toBe("PENDING");
    expect(svc.isValid("auth0|abc")).toBe(false);
  });

  it("Persona: a refresh after approval unlocks, and restarting resumes the same inquiry", async () => {
    const f = personaFetch({ status: "approved" });
    const svc = new KycService(new InvestorStore(), persona(f as unknown as typeof fetch));
    await svc.start("u1");
    await svc.start("u1"); // resume: no second inquiry
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/inquiries")).length).toBe(1);
    expect((await svc.refresh("u1")).status).toBe("VALID");
  });

  it("Persona: a failed link is not fatal (the inquiry is kept)", async () => {
    const svc = new KycService(new InvestorStore(), persona(personaFetch({ linkOk: false }) as unknown as typeof fetch));
    expect(await svc.start("u1")).toMatchObject({ status: "PENDING", inquiryId: "inq_123", hostedUrl: null });
  });
});

describe("Persona webhook", () => {
  it("applies a correctly signed decision to the investor with that inquiry", async () => {
    const provider = persona(personaFetch() as unknown as typeof fetch);
    const svc = new KycService(new InvestorStore(), provider);
    await svc.start("u1");
    const ctrl = new KycController(svc);
    const raw = event("approved");
    expect(ctrl.webhook({ rawBody: Buffer.from(raw) }, sign(raw))).toEqual({ received: true, applied: true });
    expect(svc.isValid("u1")).toBe(true);
  });

  it("rejects a bad signature, a stale timestamp, and fails closed without a secret", async () => {
    const svc = new KycService(new InvestorStore(), persona(personaFetch() as unknown as typeof fetch));
    await svc.start("u1");
    const ctrl = new KycController(svc);
    const raw = event("approved");
    expect(() => ctrl.webhook({ rawBody: Buffer.from(raw) }, sign(raw, "wrong"))).toThrow(/Invalid webhook signature/);
    expect(() => ctrl.webhook({ rawBody: Buffer.from(raw) }, sign(raw, "whsec", Math.floor(Date.now() / 1000) - 3600))).toThrow(/outside tolerance/);
    expect(() => ctrl.webhook({ rawBody: Buffer.from(raw) }, undefined)).toThrow(/Missing webhook signature/);
    const noSecret = new KycController(new KycService(new InvestorStore(), persona(personaFetch() as unknown as typeof fetch, null)));
    expect(() => noSecret.webhook({ rawBody: Buffer.from(raw) }, sign(raw))).toThrow(/not configured/);
    expect(svc.isValid("u1")).toBe(false);
  });

  it("reads the inquiry from payload.included too (newer webhook API versions)", async () => {
    const provider = persona(personaFetch() as unknown as typeof fetch);
    const svc = new KycService(new InvestorStore(), provider);
    await svc.start("u1");
    const raw = JSON.stringify({
      data: {
        attributes: {
          name: "inquiry.approved",
          payload: { data: { type: "event", id: "evt_1" }, included: [{ type: "inquiry", id: "inq_123", attributes: { status: "approved" } }] },
        },
      },
    });
    expect(new KycController(svc).webhook({ rawBody: Buffer.from(raw) }, sign(raw))).toEqual({ received: true, applied: true });
    expect(svc.isValid("u1")).toBe(true);
  });

  it("does not downgrade a final decision with a late event", async () => {
    const svc = new KycService(new InvestorStore(), persona(personaFetch() as unknown as typeof fetch));
    await svc.start("u1");
    expect(svc.applyDecision("inq_123", "VALID", "Persona: approved")).toBe(true);
    svc.applyDecision("inq_123", "PENDING", "Persona: pending");
    expect(svc.isValid("u1")).toBe(true);
  });
});

describe("identity from the token", () => {
  it("ignores a body userId when a verified token is present, and 401s when Auth0 is on without one", async () => {
    const svc = new KycService(new InvestorStore(), new MockKycProvider());
    const ctrl = new KycController(svc);
    const out = await ctrl.start({ userId: "victim" }, { user: { sub: "auth0|me" } });
    expect(out.userId).toBe("auth0|me");
    expect(svc.isValid("victim")).toBe(false);
    process.env.AUTH0_DOMAIN = "x.auth0.com";
    process.env.AUTH0_AUDIENCE = "aud";
    expect(() => ctrl.start({ userId: "victim" }, {})).toThrow(/Sign in/);
  });
});
