import type { AuthedRequest } from "./identity.js";

/**
 * Auth0 access tokens carry no email by default. Rather than require an Auth0 Action (dashboard
 * config that silently drifts), ask Auth0's /userinfo with the investor's own token, which the SPA
 * requests with the openid email scope. Cached per subject; failures return null (email is
 * informational, never used for access decisions).
 */
const cache = new Map<string, { email: string | null; at: number }>();
const TTL_MS = 60 * 60 * 1000;

export async function emailFromAuth0(req: AuthedRequest & { headers?: Record<string, string | undefined> }, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const direct = req?.user?.email ?? req?.user?.["https://dipbuyer.ai/email"];
  if (typeof direct === "string") return direct;
  const sub = req?.user?.sub;
  const domain = process.env.AUTH0_DOMAIN;
  const auth = req?.headers?.authorization;
  if (!sub || !domain || !auth?.startsWith("Bearer ")) return null;
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.email;
  try {
    const res = await fetchImpl(`https://${domain}/userinfo`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(4000) });
    const email = res.ok ? (((await res.json()) as { email?: unknown }).email ?? null) : null;
    const value = typeof email === "string" ? email : null;
    cache.set(sub, { email: value, at: Date.now() });
    return value;
  } catch {
    return null;
  }
}
