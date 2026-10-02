import { redirect } from "next/navigation";

/** The KYC + suitability form became the onboarding wizard. */
export default function SuitabilityRedirect() {
  redirect("/onboarding");
}
