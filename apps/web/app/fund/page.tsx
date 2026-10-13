import type { Metadata } from "next";
import { FundQuote } from "./fund-quote";

export const metadata: Metadata = {
  title: "Fund on Monad from any chain — simulated with Aurora Intents",
  description:
    "A live Aurora Intents dry-run quote for paying in USDC from Base and receiving USDC or MON on Monad. Simulation only: nothing is sent.",
};

export default function FundPage() {
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Any-chain liquidity to Monad</span>
        <h1>
          Pay from another chain, <span className="grad-text">arrive on Monad</span>
        </h1>
        <p>
          A DipBuyer access plan could be paid in USDC on Monad. Most people hold funds elsewhere, so Aurora Intents (NEAR Intents)
          routes the payment from another chain into Monad. This page asks Aurora for a live quote for that route.
        </p>
      </div>
      <FundQuote />
      <div className="card" style={{ padding: "8px 20px 16px", marginTop: 20 }}>
        <p className="footnote">
          <b>Simulation, by design.</b> Aurora Intents serves Monad mainnet only (chain 143); it has no Monad testnet. The hackathon
          work runs on testnet, so this flow stops at the quote: it uses Aurora&apos;s <code>dry</code> mode, which returns the price
          without a deposit address. The quote is real and live; the payment is not made. The new work here is this page and
          <code> /api/aurora-quote</code>.
        </p>
      </div>
    </div>
  );
}
