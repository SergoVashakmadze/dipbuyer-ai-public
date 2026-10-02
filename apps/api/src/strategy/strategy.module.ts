import { Module } from "@nestjs/common";
import { StrategyController } from "./strategy.controller.js";

@Module({ controllers: [StrategyController] })
export class StrategyModule {}
