import { Body, Controller, Post } from "@nestjs/common";
import { BacktestService, type BacktestRequest } from "./backtest.service.js";

/**
 * Backtest endpoint. Reproducible, point-in-time, bias-controlled (the engine enforces no
 * look-ahead). Returns equity curve + metrics + decision count. Demo dataset until real
 * adapters are wired; the engine is identical to the live decision path.
 */
@Controller("backtest")
export class BacktestController {
  constructor(private readonly service: BacktestService) {}

  @Post()
  async run(@Body() body: BacktestRequest) {
    return this.service.run(body ?? {});
  }
}
