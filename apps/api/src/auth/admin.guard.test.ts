import { describe, expect, it } from "vitest";
import { adminDecision } from "./admin.guard.js";

const auth = { AUTH0_DOMAIN: "x.eu.auth0.com", AUTH0_AUDIENCE: "https://api" };
const as = (sub?: string) => ({ user: sub ? { sub } : undefined }) as never;

describe("adminDecision", () => {
  it("admits only subjects listed in ADMIN_SUBJECTS", () => {
    const env = { ...auth, ADMIN_SUBJECTS: "google-oauth2|owner, auth0|backup" };
    expect(adminDecision(as("google-oauth2|owner"), env).admin).toBe(true);
    expect(adminDecision(as("auth0|backup"), env).admin).toBe(true);
    expect(adminDecision(as("google-oauth2|someone-else"), env)).toEqual({ admin: false, reason: "this account is not an admin" });
    expect(adminDecision(as(), env).admin).toBe(false);
  });

  it("has no admin when none is configured", () => {
    expect(adminDecision(as("google-oauth2|owner"), { ...auth }).reason).toMatch(/ADMIN_SUBJECTS is empty/);
  });

  it("without Auth0 nobody is admin, unless local dev opts in — never in production", () => {
    expect(adminDecision(as(), {}).admin).toBe(false);
    expect(adminDecision(as(), { ADMIN_ALLOW_LOCAL: "true" }).admin).toBe(true);
    expect(adminDecision(as(), { ADMIN_ALLOW_LOCAL: "true", NODE_ENV: "production" }).admin).toBe(false);
    // With Auth0 on, the local flag grants nothing.
    expect(adminDecision(as("auth0|x"), { ...auth, ADMIN_ALLOW_LOCAL: "true" }).admin).toBe(false);
  });
});
