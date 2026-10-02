"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useOnboarding } from "../lib/onboarding";

/** Pages that act on money. Research stays open to everyone. */
const ACTION_PAGES = ["/agent", "/portfolio"];

/**
 * Sends a signed-in investor who has not finished onboarding to the wizard before any page that can
 * place a trade, then back again (?next=). Also renders the header status pill.
 */
export function OnboardingStatus() {
  const path = usePathname() ?? "/";
  const router = useRouter();
  const { data, ready } = useOnboarding();
  useEffect(() => {
    if (!ready || !data || data.complete) return;
    if (ACTION_PAGES.some((p) => path.startsWith(p))) router.replace(`/onboarding?next=${encodeURIComponent(path)}`);
  }, [ready, data, path, router]);
  if (!ready || !data || path.startsWith("/onboarding")) return null;
  if (data.complete)
    return (
      <a className="status-chip ok" href="/onboarding" title={data.kyc.demo ? "Onboarded (demo identity check)" : "Identity verified, suitability assessed"}>
        ✓ {data.kyc.demo ? "Onboarded (demo)" : "Verified"}
      </a>
    );
  const blocked = data.steps.identity === "rejected" || data.steps.suitability === "unsuitable";
  return (
    <a className={`status-chip ${blocked ? "bad" : "todo"}`} href="/onboarding">
      {blocked ? "Onboarding needs attention" : data.steps.identity === "in_review" ? "Verification in review" : "Finish onboarding"}
    </a>
  );
}
