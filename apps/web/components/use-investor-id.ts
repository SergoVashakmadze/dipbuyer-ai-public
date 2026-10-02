"use client";

import { useAuth0 } from "@auth0/auth0-react";

/**
 * The id KYC, suitability and trade approvals are recorded against. Signed in: the Auth0 subject.
 * Auth0 not configured (local dev): "demo-user", the id the onboarding page has always used, so
 * onboarding once and approving trades line up.
 */
export function useInvestorId(): string {
  const { isAuthenticated, user } = useAuth0();
  return isAuthenticated && user?.sub ? user.sub : "demo-user";
}
