import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthController } from "./health.controller.js";
import { DecisionModule } from "./decision/decision.module.js";
import { BacktestModule } from "./backtest/backtest.module.js";
import { OrdersModule } from "./orders/orders.module.js";
import { SuitabilityModule } from "./suitability/suitability.module.js";
import { ReportingModule } from "./reporting/reporting.module.js";
import { KycModule } from "./kyc/kyc.module.js";
import { StrategyModule } from "./strategy/strategy.module.js";
import { AgentModule } from "./agent/agent.module.js";
import { ResearchModule } from "./research/research.module.js";
import { WatchlistModule } from "./watchlist/watchlist.js";
import { DigestModule } from "./digest/digest.js";
import { ModelsModule } from "./models/models.js";
import { AdminModule } from "./admin/admin.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { InvestorsModule } from "./investors/investors.module.js";
import { OnboardingModule } from "./onboarding/onboarding.module.js";

@Module({
  imports: [InvestorsModule, OnboardingModule, DecisionModule, BacktestModule, OrdersModule, SuitabilityModule, ReportingModule, KycModule, StrategyModule, AgentModule, ResearchModule, WatchlistModule, DigestModule, ModelsModule, AdminModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
