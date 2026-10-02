import { afterEach, describe, expect, it, vi } from "vitest";
import { emailFromAuth0 } from "./userinfo.js";

afterEach(() => {
  delete process.env.AUTH0_DOMAIN;
});

describe("emailFromAuth0", () => {
  it("uses a claim when present, else asks /userinfo with the caller's own token, once per subject", async () => {
    expect(await emailFromAuth0({ user: { sub: "a", email: "claim@x.io" } })).toBe("claim@x.io");
    process.env.AUTH0_DOMAIN = "t.auth0.com";
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ email: "info@x.io" }), { status: 200 }));
    const req = { user: { sub: "auth0|u1" }, headers: { authorization: "Bearer tok" } };
    expect(await emailFromAuth0(req, f as unknown as typeof fetch)).toBe("info@x.io");
    expect(await emailFromAuth0(req, f as unknown as typeof fetch)).toBe("info@x.io");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("https://t.auth0.com/userinfo");
  });

  it("returns null without a token or when Auth0 fails", async () => {
    process.env.AUTH0_DOMAIN = "t.auth0.com";
    expect(await emailFromAuth0({ user: { sub: "x" } })).toBeNull();
    const bad = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await emailFromAuth0({ user: { sub: "auth0|u2" }, headers: { authorization: "Bearer t" } }, bad as unknown as typeof fetch)).toBeNull();
  });
});
