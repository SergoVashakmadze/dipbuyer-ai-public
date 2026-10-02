"use client";

import { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";

/**
 * Returns a fetch wrapper that attaches the Auth0 access token as a Bearer header when the user
 * is authenticated. When Auth0 is unconfigured/anonymous it sends no header — which is fine
 * because the API's guard is inert until configured and research endpoints are public.
 */
export function useAuthedFetch() {
  const { isAuthenticated, getAccessTokenSilently } = useAuth0();
  return useCallback(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      let headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
      if (isAuthenticated) {
        try {
          const token = await getAccessTokenSilently();
          headers = { ...headers, Authorization: `Bearer ${token}` };
        } catch (e) {
          // Session expired / consent required. Proceed unauthenticated — guarded endpoints
          // will 401 — but surface why, otherwise it looks like a random API failure.
          console.warn("[auth] could not get access token; sending request unauthenticated", e);
        }
      }
      return fetch(input, { ...init, headers });
    },
    [isAuthenticated, getAccessTokenSilently],
  );
}
