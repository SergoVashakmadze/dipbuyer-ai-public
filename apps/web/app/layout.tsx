import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "../components/auth-provider";
import { DemoNotice, SiteFooter, SiteHeader } from "../components/site-header";
import { TickerTape } from "../components/tradingview";
import { THEME_SCRIPT } from "../components/theme";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://dipbuyer.ai"),
  // "./" resolves against each route's own pathname, so every page declares itself
  // on the apex. That also canonicalises app.dipbuyer.ai and ?query variants to it.
  alternates: { canonical: "./" },
  title: "DipBuyer AI — value-investing research, technology demonstration",
  description:
    "Technology demonstration, not offered as a service: research software that applies Peter Lynch's published value-investing criteria, with each decision explained, backtested and recorded on-chain.",
  // The site name Google prints in the grey line above a result. Without it —
  // and this site declared nothing at all — Search works down to the <title>
  // and then to the bare lowercase domain. Keep it identical to the WebSite
  // entity below; a split between the two is read as an unreliable signal.
  openGraph: {
    type: "website",
    url: "https://dipbuyer.ai/",
    siteName: "DipBuyer.ai",
    description:
      "Technology demonstration, not offered as a service. Nothing is available for investment, trading, advice or payment until licensing, penetration testing and security audits are complete.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "DipBuyer.ai",
              url: "https://dipbuyer.ai/",
              description:
                "Technology demonstration, not offered as a service. Nothing is available for investment, trading, advice or payment until the required licences, penetration testing and security audits are complete.",
            }),
          }}
        />
        <DemoNotice />
        <AuthProvider>
          <div className="ticker-strip">
            <TickerTape />
          </div>
          <SiteHeader />
          <div className="disclaimer">
            Capital at risk. Past performance is not a guide to future results. Research and education, not a personal recommendation.
          </div>
          <main className="container">{children}</main>
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
