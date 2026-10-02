import type { IntendedAction } from "@dipbuyer/shared";

/**
 * Broker abstraction. Isolates Alpaca US vs Alpaca Europe (ex-WealthKernel, FCA-authorised)
 * vs a paper simulator. ALL orders require a client-generated idempotency key (money-safety).
 */
export interface OrderResult {
  brokerOrderId: string;
  clientOrderId: string; // == idempotencyKey
  status: "accepted" | "filled" | "partially_filled" | "rejected" | "canceled";
  filledQty?: number;
  filledAvgPrice?: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

export interface IBroker {
  readonly id: "alpaca-us" | "alpaca-eu" | "paper";
  placeOrder(action: IntendedAction): Promise<OrderResult>;
  getPositions(): Promise<Position[]>;
  getCash(): Promise<number>;
}

export { PaperBroker } from "./paper.js";
export { checkRisk, maxBuyNotional, sectorHeadroom } from "./risk.js";
export type { RiskParams, RiskContext, RiskVerdict, SectorRiskParams } from "./risk.js";
export { markPosition, portfolioValue } from "./valuation.js";
export type { BasicPosition, ValuedPosition } from "./valuation.js";
export { AlpacaTradingBroker } from "./alpaca.js";
export type { AlpacaTradingOptions } from "./alpaca.js";
// TODO: AlpacaEuBroker (Alpaca Europe / FCA) + Broker API for white-label multi-account.
export { sizeBuys, guardrailsFromConfig } from "./sizing.js";
export type { SizingGuardrails, BuyCandidate, HeldPosition, SizedBuy, SizingResult } from "./sizing.js";
export { DEFAULT_ALLOCATION, allocationFromConfig, satelliteCash, planCore } from "./allocation.js";
export type { AllocationPolicy, CoreTrade } from "./allocation.js";
export { attribute, performanceSeries } from "./ledger.js";
export type { Attribution, LedgerEntry, PortfolioSnapshot, Sleeve, SleeveHolding, SleeveSummary, TradeSource } from "./ledger.js";
export { planCopy, weightsOf } from "./copy.js";
export type { CopyTrade } from "./copy.js";
