import { Module } from "@nestjs/common";
import { FileAgentRunStore, InMemoryAgentRunStore, type AgentRunStore } from "@dipbuyer/agent";
import { AgentController } from "./agent.controller.js";
import { AGENT_RUN_STORE, AgentService } from "./agent.service.js";
import { AgentScheduler } from "./agent.scheduler.js";
import { DecisionModule } from "../decision/decision.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { SuitabilityModule } from "../suitability/suitability.module.js";
import { KycModule } from "../kyc/kyc.module.js";

/** Runs persist to a JSON file when AGENT_RUNS_PATH is set, otherwise in memory. */
const runStoreProvider = {
  provide: AGENT_RUN_STORE,
  useFactory: (): AgentRunStore => (process.env.AGENT_RUNS_PATH ? new FileAgentRunStore(process.env.AGENT_RUNS_PATH) : new InMemoryAgentRunStore()),
};

@Module({
  imports: [DecisionModule, OrdersModule, SuitabilityModule, KycModule],
  controllers: [AgentController],
  providers: [AgentService, AgentScheduler, runStoreProvider],
  exports: [runStoreProvider, AgentService],
})
export class AgentModule {}
