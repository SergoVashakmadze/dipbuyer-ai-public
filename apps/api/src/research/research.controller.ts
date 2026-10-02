import { BadRequestException, Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";
import { RESEARCH_SERVICE } from "./research.providers.js";
import type { ResearchService } from "./research.service.js";

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * "This provider has nothing for the ticker", as each fundamentals adapter phrases it, so the
 * page can say "unknown ticker" (404) rather than "server error" (500). Upstream HTTP failures
 * are not matched and stay 500s.
 */
export function isUnknownSymbol(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no fundamentals for|no metrics|no us-gaap facts|no CIK for|: HTTP 404/i.test(msg);
}

/**
 * Research endpoints behind the stock and screener pages. Public, like GET /decisions/:symbol:
 * they are read-only research, never execution.
 */
@Controller("research")
export class ResearchController {
  constructor(@Inject(RESEARCH_SERVICE) private readonly research: ResearchService) {}

  /** GET /research/screener — the curated universe with verdicts, valuation and dip context. */
  @Public()
  @Get("screener")
  screener() {
    return this.research.screener();
  }

  /** GET /research/:symbol — decision plus price context, fair-value models and quality profile. */
  @Public()
  @Get(":symbol")
  async view(@Param("symbol") symbol: string) {
    const s = symbol.toUpperCase();
    if (!SYMBOL.test(s)) throw new BadRequestException("Invalid symbol");
    try {
      return await this.research.view(s);
    } catch (err) {
      if (isUnknownSymbol(err)) throw new NotFoundException(`No fundamentals available for ${s}`);
      throw err;
    }
  }
}
