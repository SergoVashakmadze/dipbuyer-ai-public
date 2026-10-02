import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import type { AnalyzeOptions, DecisionService, DecisionStore } from "@dipbuyer/agent";
import type { RuntimeMode } from "@dipbuyer/shared";
import { AlgodAnchorer, hashDecision } from "@dipbuyer/chain";
import { DECISION_SERVICE, DECISION_STORE } from "./decision.providers.js";
import { Public } from "../auth/public.decorator.js";

/**
 * Decision endpoints. The runtime mode is enforced server-side (default RESEARCH_ONLY) — the
 * client cannot escalate it. Execution is always PAPER here until live trading is wired + gated.
 * Every response includes the audit hash; decisions are persisted to the audit store, and can
 * be anchored on Algorand for independent verification.
 */
@Controller("decisions")
export class DecisionController {
  constructor(
    @Inject(DECISION_SERVICE) private readonly service: DecisionService,
    @Inject(DECISION_STORE) private readonly store: DecisionStore,
  ) {}

  private opts(asOf?: string): AnalyzeOptions {
    const mode = (process.env.RUNTIME_MODE as RuntimeMode) ?? "RESEARCH_ONLY";
    return { mode, execution: "PAPER", asOf };
  }

  /** GET /decisions — recent persisted decisions (audit trail). */
  @Get()
  async recent(@Query("limit") limit?: string) {
    return this.store.recent(limit ? Number(limit) : 50);
  }

  /** GET /decisions/:symbol?asOf=ISO — analyse one symbol (public research). */
  @Public()
  @Get(":symbol")
  async analyze(@Param("symbol") symbol: string, @Query("asOf") asOf?: string) {
    return this.service.analyze(symbol.toUpperCase(), this.opts(asOf));
  }

  /** POST /decisions/screen { symbols, asOf? } — ranked buy candidates (auth when configured). */
  @Post("screen")
  async screen(@Body() body: { symbols: string[]; asOf?: string }) {
    const symbols = (body.symbols ?? []).map((s) => s.toUpperCase());
    return this.service.screen(symbols, this.opts(body.asOf));
  }

  /** POST /decisions/:symbol/anchor — anchor the latest decision's hash on Algorand. */
  @Post(":symbol/anchor")
  async anchor(@Param("symbol") symbol: string) {
    const rec = await this.store.latestFor(symbol.toUpperCase());
    if (!rec) throw new NotFoundException(`No decision recorded for ${symbol.toUpperCase()} yet`);
    const hash = hashDecision(rec);
    const mnemonic = process.env.ALGORAND_ANCHOR_MNEMONIC;
    const algodUrl = process.env.ALGOD_URL;
    if (!mnemonic || !algodUrl) {
      return { anchored: false, reason: "Algorand not configured (set ALGORAND_ANCHOR_MNEMONIC + ALGOD_URL)", hash };
    }
    const txid = await new AlgodAnchorer({ mnemonic, algodUrl }).anchor(hash);
    return { anchored: true, txid, hash };
  }
}
