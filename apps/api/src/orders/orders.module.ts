import { Module } from "@nestjs/common";
import { OrdersController } from "./orders.controller.js";
import { brokerProvider } from "./orders.providers.js";
import { marketDataProvider } from "./market-data.provider.js";
import { ledgerProvider, snapshotProvider } from "./portfolio.store.js";
import { SuitabilityModule } from "../suitability/suitability.module.js";
import { KycModule } from "../kyc/kyc.module.js";

@Module({
  imports: [SuitabilityModule, KycModule],
  controllers: [OrdersController],
  providers: [brokerProvider, marketDataProvider, ledgerProvider, snapshotProvider],
  exports: [brokerProvider, marketDataProvider, ledgerProvider, snapshotProvider],
})
export class OrdersModule {}
