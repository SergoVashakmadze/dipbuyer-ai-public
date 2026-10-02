import { UnauthorizedException } from "@nestjs/common";

export interface AuthedRequest {
  user?: { sub?: string; email?: string; [claim: string]: unknown };
}

/** Auth0 is enforced exactly when the guard enforces it. */
export const authConfigured = () => Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_AUDIENCE);

/**
 * Whose record an action touches. With Auth0 on, ONLY the verified token subject counts: a userId
 * in the request body is ignored, so nobody can onboard, approve trades or place orders as someone
 * else. With Auth0 off (local dev), the body value or "demo-user" is used.
 */
export function resolveUserId(req: AuthedRequest | undefined, claimed?: string): string {
  const sub = req?.user?.sub;
  if (typeof sub === "string" && sub) return sub;
  if (authConfigured()) throw new UnauthorizedException("Sign in to continue");
  return claimed?.trim() || "demo-user";
}

export const emailOf = (req: AuthedRequest | undefined): string | null => {
  const e = req?.user?.email ?? req?.user?.["https://dipbuyer.ai/email"];
  return typeof e === "string" ? e : null;
};
