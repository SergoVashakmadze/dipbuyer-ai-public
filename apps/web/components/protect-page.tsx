"use client";

import type { ComponentType } from "react";
import { withAuthenticationRequired } from "@auth0/auth0-react";

/**
 * Gates a page behind Auth0, redirecting anonymous visitors to the login screen.
 *
 * Env-gated the same way as `AuthProvider` and the API's guard: when Auth0 is unconfigured the
 * component is returned untouched, so dev/demo runs stay open and we never call an Auth0 hook
 * outside its provider. `NEXT_PUBLIC_*` is inlined at build time, so this branch is static.
 */
const auth0Configured = Boolean(
  process.env.NEXT_PUBLIC_AUTH0_DOMAIN && process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID,
);

export function protectPage<P extends object>(Page: ComponentType<P>): ComponentType<P> {
  if (!auth0Configured) return Page;
  return withAuthenticationRequired(Page, {
    onRedirecting: () => <p className="muted">Signing you in…</p>,
  });
}
