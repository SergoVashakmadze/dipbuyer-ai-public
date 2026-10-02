import { Module } from "@nestjs/common";
import { DecisionController } from "./decision.controller.js";
import { decisionServiceProvider, decisionStoreProvider } from "./decision.providers.js";

@Module({
  controllers: [DecisionController],
  providers: [decisionStoreProvider, decisionServiceProvider],
  exports: [decisionStoreProvider, decisionServiceProvider],
})
export class DecisionModule {}
