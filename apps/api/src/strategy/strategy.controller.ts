import { Controller, Get } from "@nestjs/common";
import { loadStrategyConfig } from "@dipbuyer/strategy";
import { Public } from "../auth/public.decorator.js";

/**
 * Methodology transparency — exposes the exact Peter Lynch thresholds the engine uses, plus the
 * config hash stamped into every decision. Transparency IS the product (PROMPT.md §1); this lets
 * users, partners and regulators inspect the rules. Public.
 */
@Controller("strategy")
export class StrategyController {
  @Public()
  @Get("config")
  config() {
    const { config, hash } = loadStrategyConfig();
    return { hash, config };
  }
}
