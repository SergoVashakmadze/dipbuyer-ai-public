import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { AuthedRequest } from "./identity.js";

/**
 * Admin access = the verified Auth0 subject is listed in ADMIN_SUBJECTS (comma-separated, e.g.
 * "google-oauth2|1234,auth0|abcd"). The subject is signed into the access token and cannot be
 * changed by the user; email is NOT used (access tokens carry none, and userinfo email is
 * informational only).
 *
 * Without Auth0 (local dev) there is no verified identity, so nobody is admin unless
 * ADMIN_ALLOW_LOCAL=true — which is ignored when NODE_ENV=production.
 */
export function adminDecision(req: AuthedRequest | undefined, env: NodeJS.ProcessEnv = process.env): { admin: boolean; reason: string } {
  const authConfigured = !!(env.AUTH0_DOMAIN && env.AUTH0_AUDIENCE);
  if (!authConfigured) {
    return env.ADMIN_ALLOW_LOCAL === "true" && env.NODE_ENV !== "production"
      ? { admin: true, reason: "local development (ADMIN_ALLOW_LOCAL)" }
      : { admin: false, reason: "sign-in is not configured on this server, so there is no verified admin" };
  }
  const sub = req?.user?.sub;
  if (typeof sub !== "string" || !sub) return { admin: false, reason: "not signed in" };
  const admins = (env.ADMIN_SUBJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.length) return { admin: false, reason: "no admin is configured (ADMIN_SUBJECTS is empty)" };
  return admins.includes(sub) ? { admin: true, reason: "listed in ADMIN_SUBJECTS" } : { admin: false, reason: "this account is not an admin" };
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const d = adminDecision(context.switchToHttp().getRequest<AuthedRequest>());
    if (!d.admin) throw new ForbiddenException(`Admin only: ${d.reason}`);
    return true;
  }
}
