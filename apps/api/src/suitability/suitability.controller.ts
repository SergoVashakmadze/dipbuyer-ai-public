import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { SuitabilityService, type SuitabilityInput } from "./suitability.service.js";

/** Suitability endpoints (COBS 9A). The acting user comes from the Auth0 token when Auth0 is on. */
@Controller("suitability")
export class SuitabilityController {
  constructor(private readonly service: SuitabilityService) {}

  @Post()
  assess(@Body() body: SuitabilityInput, @Req() req?: AuthedRequest) {
    if (!body?.riskTolerance || !body?.capacityForLoss || !body?.knowledgeExperience) {
      throw new BadRequestException("riskTolerance, capacityForLoss and knowledgeExperience are required");
    }
    return this.service.assess({ ...body, userId: resolveUserId(req, body.userId) });
  }

  @Get(":userId")
  get(@Param("userId") userId: string, @Req() req?: AuthedRequest) {
    const id = resolveUserId(req, userId);
    const rec = this.service.get(id);
    if (!rec) throw new NotFoundException(`No suitability assessment for ${id}`);
    return rec;
  }
}
