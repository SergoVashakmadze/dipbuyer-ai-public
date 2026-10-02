import { AlpacaTradingBroker, PaperBroker, type IBroker } from "@dipbuyer/brokers";

export const BROKER = "BROKER";

/**
 * Broker selection: Alpaca Trading API (paper unless ALPACA_ENV=live) when keys are present,
 * else (or with BROKER=paper) the in-memory PaperBroker. Same IBroker interface either way.
 */
export const brokerProvider = {
  provide: BROKER,
  useFactory: (): IBroker => {
    const keyId = process.env.ALPACA_KEY_ID;
    const secretKey = process.env.ALPACA_SECRET_KEY;
    // BROKER=paper forces the in-memory simulator even when Alpaca keys are present (demos, and
    // trying the agent's approval flow without touching the Alpaca paper account).
    if (keyId && secretKey && process.env.BROKER !== "paper") {
      return new AlpacaTradingBroker({ keyId, secretKey, paper: process.env.ALPACA_ENV !== "live" });
    }
    return new PaperBroker({
      initialCash: Number(process.env.PAPER_INITIAL_CASH ?? 100_000),
      priceFor: () => 0,
      commissionBps: Number(process.env.PAPER_COMMISSION_BPS ?? 0),
    });
  },
};
