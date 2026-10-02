import { Module } from "@nestjs/common";
import { BacktestController } from "./backtest.controller.js";
import { BacktestService } from "./backtest.service.js";

@Module({
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
