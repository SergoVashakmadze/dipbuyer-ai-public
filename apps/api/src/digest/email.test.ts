import { describe, expect, it, vi } from "vitest";
import { LogEmailSender, ResendEmailSender, emailSenderFromEnv } from "./digest.js";

describe("email senders", () => {
  it("defaults to logging, and refuses a half-configured provider at boot", () => {
    expect(emailSenderFromEnv({})).toBeInstanceOf(LogEmailSender);
    expect(() => emailSenderFromEnv({ EMAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => emailSenderFromEnv({ EMAIL_PROVIDER: "carrier-pigeon" })).toThrow(/not one of/);
    expect(emailSenderFromEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_FROM: "a@b.c" }).id).toBe("resend");
  });

  it("sends one Resend request per message and surfaces failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const s = new ResendEmailSender("re_key", "DipBuyer <digest@dipbuyer.ai>", fetchImpl as unknown as typeof fetch);
    await s.send({ to: "jane@example.com", subject: "S", html: "<p>H</p>", text: "T" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(String(init.body))).toEqual({ from: "DipBuyer <digest@dipbuyer.ai>", to: ["jane@example.com"], subject: "S", html: "<p>H</p>", text: "T" });
    const failing = new ResendEmailSender("k", "f", (async () => new Response("domain not verified", { status: 403 })) as unknown as typeof fetch);
    await expect(failing.send({ to: "x@y.z", subject: "", html: "", text: "" })).rejects.toThrow(/HTTP 403 domain not verified/);
  });
});

describe("Cloudflare sender", () => {
  it("posts to the account's email/sending endpoint with {address,name} and reports bounces", async () => {
    const { CloudflareEmailSender, emailSenderFromEnv } = await import("./digest.js");
    expect(() => emailSenderFromEnv({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "a@b.c" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    const ok = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { delivered: ["j@e.com"], permanent_bounces: [], queued: [] } }), { status: 200 }));
    const s = new CloudflareEmailSender("acc1", "tok", "DipBuyer <alerts@dipbuyer.ai>", ok as unknown as typeof fetch);
    await s.send({ to: "j@e.com", subject: "S", html: "H", text: "T", headers: { "List-Unsubscribe": "<https://dipbuyer.ai/digest>" } });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/email/sending/send");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: { address: "alerts@dipbuyer.ai", name: "DipBuyer" }, to: "j@e.com", headers: { "List-Unsubscribe": "<https://dipbuyer.ai/digest>" } });
    const bounce = new CloudflareEmailSender("a", "t", "x@y.z", (async () => new Response(JSON.stringify({ success: true, result: { delivered: [], permanent_bounces: ["j@e.com"], queued: [] } }))) as unknown as typeof fetch);
    await expect(bounce.send({ to: "j@e.com", subject: "", html: "", text: "" })).rejects.toThrow(/permanent bounce/);
    const denied = new CloudflareEmailSender("a", "t", "x@y.z", (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Sender domain not verified" }] }), { status: 400 })) as unknown as typeof fetch);
    await expect(denied.send({ to: "j@e.com", subject: "", html: "", text: "" })).rejects.toThrow(/Sender domain not verified/);
  });
});
