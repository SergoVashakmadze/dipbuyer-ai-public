import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Loads the canonical Lynch strategy config (config/strategy.lynch.json) and exposes
 * its SHA-256 hash. The hash is stamped into every DecisionRecord (model.strategyConfigHash)
 * so a decision can be reproduced against the exact thresholds in force.
 */

export interface StrategyConfig {
  version: string;
  conventions: { peg_convention: "lower_is_better"; growth_units: string };
  understandability_gate: Record<string, unknown>;
  categories: Record<string, CategoryConfig>;
  global_criteria: Record<string, Record<string, unknown>>;
  scoring: {
    verdict_bands: { buy_gte: number; hold_band: [number, number]; avoid_sell_lt: number };
    /** Categories whose "buy" verdict is capped at "hold" (experiment configs only so far). */
    buy_excluded_categories?: string[];
    /** Cap "buy" at "hold" when trailing EPS growth is negative (experiment configs only so far). */
    buy_block_negative_eps_growth?: boolean;
    /** Cap "buy" at "hold" unless this checklist criterion PASSED (experiment configs only). */
    buy_require_criterion?: string;
  };
  risk_guardrails: Record<string, number | string>;
  /** Core + satellite product settings (core_symbol, satellite_pct_default, cash_floor_pct, core_band_pct). */
  portfolio_construction?: Record<string, unknown>;
}

export interface CategoryConfig {
  id: Record<string, unknown>;
  buy: Record<string, unknown>;
  sell: Record<string, unknown>;
  weights: Record<string, number>;
  provenance: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../../config/strategy.lynch.json");

const cached = new Map<string, { config: StrategyConfig; hash: string }>();

/**
 * `STRATEGY_CONFIG_PATH` swaps in an experiment config (see config/experiments/) for backtests.
 * The hash stamped on every decision changes with it, so experiment decisions can never be
 * mistaken for canonical ones.
 */
export function loadStrategyConfig(path: string = process.env.STRATEGY_CONFIG_PATH || DEFAULT_CONFIG_PATH): {
  config: StrategyConfig;
  hash: string;
} {
  const hit = cached.get(path);
  if (hit) return hit;
  const raw = readFileSync(path, "utf8");
  const config = JSON.parse(raw) as StrategyConfig;
  const hash = createHash("sha256").update(raw).digest("hex");
  const entry = { config, hash };
  cached.set(path, entry);
  return entry;
}
