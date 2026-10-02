import { Module } from "@nestjs/common";
import { DecisionModule } from "../decision/decision.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { ResearchController } from "./research.controller.js";
import { InsidersController } from "./insiders.js";
import { InsiderRefresher } from "./insider-refresh.js";
import { researchServiceProvider } from "./research.providers.js";

@Module({
  imports: [DecisionModule, OrdersModule],
  controllers: [ResearchController, InsidersController],
  providers: [researchServiceProvider, InsiderRefresher],
  exports: [researchServiceProvider, InsiderRefresher],
})
export class ResearchModule {}
