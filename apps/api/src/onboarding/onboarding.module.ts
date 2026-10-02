import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { SuitabilityModule } from "../suitability/suitability.module.js";
import { OnboardingController } from "./onboarding.controller.js";

@Module({
  imports: [KycModule, SuitabilityModule],
  controllers: [OnboardingController],
})
export class OnboardingModule {}
