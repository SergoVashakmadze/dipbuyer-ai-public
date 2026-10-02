import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

/**
 * Auth0 JWT guard (RS256 via JWKS), env-gated:
 *  - If AUTH0_DOMAIN / AUTH0_AUDIENCE are unset, the guard is INERT (allows all) so the app
 *    boots for local/demo. Configure both to enforce.
 *  - @Public() routes are always allowed.
 *  - Otherwise a valid `Authorization: Bearer <token>` is required; issuer + audience checked.
 * Verified user claims are attached to req.user (scopes/roles drive ADVISORY/DISCRETIONARY later).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const domain = process.env.AUTH0_DOMAIN;
    const audience = process.env.AUTH0_AUDIENCE;
    if (!domain || !audience) return true; // inert until configured

    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: JWTPayload }>();
    const auth = req.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("Missing bearer token");

    this.jwks ??= createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
    try {
      const { payload } = await jwtVerify(auth.slice(7), this.jwks, {
        issuer: `https://${domain}/`,
        audience,
      });
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}
