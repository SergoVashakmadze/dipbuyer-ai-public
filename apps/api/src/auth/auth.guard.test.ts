import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { AuthGuard } from "./auth.guard.js";

/** Fake execution context whose request carries the given headers. */
function context(headers: Record<string, string> = {}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

const reflector = (isPublic: boolean): Reflector =>
  ({ getAllAndOverride: () => isPublic }) as unknown as Reflector;

const ENV = ["AUTH0_DOMAIN", "AUTH0_AUDIENCE"] as const;
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

describe("AuthGuard (env-gated Auth0 JWT)", () => {
  it("always allows @Public() routes, even when Auth0 is configured", async () => {
    process.env.AUTH0_DOMAIN = "example.auth0.com";
    process.env.AUTH0_AUDIENCE = "api";
    const guard = new AuthGuard(reflector(true));
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it("is inert (allows all) when Auth0 env is unset", async () => {
    const guard = new AuthGuard(reflector(false));
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it("rejects a protected request without a bearer token once Auth0 is configured", async () => {
    process.env.AUTH0_DOMAIN = "example.auth0.com";
    process.env.AUTH0_AUDIENCE = "api";
    const guard = new AuthGuard(reflector(false));
    await expect(guard.canActivate(context({}))).rejects.toThrow(/Missing bearer token/);
    await expect(guard.canActivate(context({ authorization: "Basic abc" }))).rejects.toThrow(/Missing bearer token/);
  });
});
