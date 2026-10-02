/**
 * Watchlist alert rules. Pure: the caller supplies each stock's current state.
 *
 * Alerts fire on a CHANGE, never on a level: a stock that is already a buy when you add it does not
 * alert, and a dip alert fires once when the drawdown crosses the threshold, not every check while it
 * stays below. The first check of an item only records the baseline.
 */

export interface AlertRules {
  /** The Lynch verdict turns "buy". */
  buy: boolean;
  /** Price falls this many percent below its 52-week high (null = off). */
  dipPct: number | null;
  /** An officer or director files an open-market purchase (>= $10k). */
  insider: boolean;
}

export const DEFAULT_RULES: AlertRules = { buy: true, dipPct: 15, insider: true };

export interface StockState {
  verdict: string | null;
  convictionScore: number | null;
  price: number | null;
  /** Fraction below the 52-week high (0.2 = 20% below). */
  drawdown: number | null;
  /** Filing date of the latest qualifying insider purchase, if any. */
  lastInsiderFiled: string | null;
  lastInsiderSummary: string | null;
}

export type AlertKind = "buy_verdict" | "dip" | "insider_buy";

export interface AlertDraft {
  kind: AlertKind;
  message: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function detectAlerts(symbol: string, rules: AlertRules, before: StockState | null, now: StockState): AlertDraft[] {
  if (!before) return []; // first check = baseline
  const out: AlertDraft[] = [];
  if (rules.buy && now.verdict === "buy" && before.verdict !== "buy") {
    out.push({
      kind: "buy_verdict",
      message: `${symbol} now rates a Lynch buy (conviction ${now.convictionScore ?? "?"}/100), up from ${before.verdict ?? "no verdict"}.`,
    });
  }
  if (rules.dipPct !== null && now.drawdown !== null) {
    const t = rules.dipPct / 100;
    if (now.drawdown >= t && (before.drawdown === null || before.drawdown < t)) {
      out.push({
        kind: "dip",
        message: `${symbol} is ${pct(now.drawdown)} below its 52-week high${now.price !== null ? ` at $${now.price.toFixed(2)}` : ""} (your alert: ${rules.dipPct}%).`,
      });
    }
  }
  if (rules.insider && now.lastInsiderFiled && (!before.lastInsiderFiled || now.lastInsiderFiled > before.lastInsiderFiled)) {
    out.push({ kind: "insider_buy", message: `Insider buying at ${symbol}: ${now.lastInsiderSummary ?? "new open-market purchase"}.` });
  }
  return out;
}
