"use client";

import type { ReactNode } from "react";
import { Auth0Provider } from "@auth0/auth0-react";

/**
 * Wraps the app in Auth0 when NEXT_PUBLIC_AUTH0_DOMAIN + CLIENT_ID are set; otherwise renders
 * children unchanged (inert in dev/demo, mirroring the API's env-gated guard).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const domain = process.env.NEXT_PUBLIC_AUTH0_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID;
  if (!domain || !clientId) return <>{children}</>;

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: typeof window !== "undefined" ? window.location.origin : undefined,
        audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE,
      }}
      // Without these the session lives only in memory: a page reload drops the user back to
      // anonymous and every guarded call 401s. Refresh tokens let getAccessTokenSilently work
      // even when third-party cookies are blocked (Safari/Brave block the silent-auth iframe).
      // Return to where login started (e.g. the onboarding wizard), not always the home page.
      onRedirectCallback={(appState) => {
        const to = appState?.returnTo;
        if (typeof to === "string" && to.startsWith("/") && !to.startsWith("//")) window.location.replace(to);
        else window.history.replaceState({}, document.title, window.location.pathname);
      }}
      useRefreshTokens
      cacheLocation="localstorage"
    >
      {children}
    </Auth0Provider>
  );
}
