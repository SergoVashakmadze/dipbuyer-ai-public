import { Module } from "@nestjs/common";
import { SuitabilityController } from "./suitability.controller.js";
import { SuitabilityService } from "./suitability.service.js";

@Module({
  controllers: [SuitabilityController],
  providers: [SuitabilityService],
  exports: [SuitabilityService],
})
export class SuitabilityModule {}
