"use client";

import { useAuth0 } from "@auth0/auth0-react";
import { useCallback, useEffect, useState } from "react";
import { useAuthedFetch } from "../components/use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";
export const auth0Configured = Boolean(process.env.NEXT_PUBLIC_AUTH0_DOMAIN && process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID);

export type StepState = "todo" | "done" | "in_review" | "rejected" | "unsuitable";

export interface Onboarding {
  userId: string;
  email: string | null;
  profile: { fullName: string; countryOfResidence: string } | null;
  kyc: { status: "PENDING" | "VALID" | "REJECTED"; provider: string; demo: boolean; inquiryId: string | null; detail: string | null; updatedAt: string };
  suitability: {
    objectives: string;
    riskTolerance: string;
    capacityForLoss: string;
    knowledgeExperience: string;
    investmentHorizon: string;
    status: "VALID" | "UNSUITABLE";
    reasons: string[];
    warnings: string[];
    riskAcknowledgedAt: string | null;
    assessedAt: string;
  } | null;
  steps: { profile: StepState; identity: StepState; suitability: StepState };
  complete: boolean;
  identityProvider: { name: string; demo: boolean };
  hostedUrl?: string | null;
}

/**
 * The signed-in investor's onboarding state. `ready` is false while Auth0 is still loading or the
 * visitor is signed out (with Auth0 configured), so callers never act on a half-known state.
 */
export function useOnboarding() {
  const { isAuthenticated, isLoading } = useAuth0();
  const authedFetch = useAuthedFetch();
  const [data, setData] = useState<Onboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canQuery = !auth0Configured || (isAuthenticated && !isLoading);

  const call = useCallback(
    async (path: string, init?: RequestInit): Promise<Onboarding> => {
      const r = await authedFetch(`${BASE}/onboarding/me${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { message?: string }).message ?? `API ${r.status}`);
      setData(body as Onboarding);
      setError(null);
      return body as Onboarding;
    },
    [authedFetch],
  );

  const refresh = useCallback(async () => {
    if (!canQuery) return null;
    try {
      return await call("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load onboarding");
      return null;
    }
  }, [call, canQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, ready: canQuery && data !== null, signedOut: auth0Configured && !isLoading && !isAuthenticated, call, refresh, setError };
}
