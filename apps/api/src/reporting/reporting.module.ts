import { Module } from "@nestjs/common";
import { ReportingController } from "./reporting.controller.js";
import { DecisionModule } from "../decision/decision.module.js";

@Module({
  imports: [DecisionModule],
  controllers: [ReportingController],
})
export class ReportingModule {}
