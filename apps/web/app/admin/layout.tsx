import type { Metadata } from "next";
import type { ReactNode } from "react";

// Signed-in page: crawlable (robots.ts does not block it) so Google can see this noindex.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
