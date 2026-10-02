import { redirect } from "next/navigation";

/** Autopilot became the Agent page (plan, approve, run history, schedule). */
export default function AutopilotRedirect() {
  redirect("/agent");
}
