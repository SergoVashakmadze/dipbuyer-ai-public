import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Logger, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { KycService } from "./kyc.service.js";

/** KYC endpoints. The acting user comes from the Auth0 token when Auth0 is on. */
@Controller("kyc")
export class KycController {
  private readonly log = new Logger("KycController");

  constructor(private readonly service: KycService) {}

  @Post("start")
  start(@Body() body: { userId?: string }, @Req() req?: AuthedRequest) {
    return this.service.start(resolveUserId(req, body?.userId));
  }

  @Get(":userId/status")
  status(@Param("userId") userId: string, @Req() req?: AuthedRequest) {
    const id = resolveUserId(req, userId);
    return { userId: id, ...this.service.state(id) };
  }

  /**
   * Persona decision webhook. Public (Persona cannot sign in), so the HMAC signature over the RAW
   * body is the only authentication, checked fail-closed with a 5-minute replay window.
   */
  @Public()
  @Post("webhook/persona")
  @HttpCode(200)
  webhook(@Req() req: { rawBody?: Buffer }, @Headers("persona-signature") signature?: string) {
    const provider = this.service.provider;
    if (!provider.parseWebhook) throw new BadRequestException("Persona is not the active identity provider");
    if (!req.rawBody) throw new BadRequestException("Raw body unavailable");
    let event;
    try {
      event = provider.parseWebhook(req.rawBody.toString("utf8"), signature);
    } catch (e) {
      throw new UnauthorizedException((e as Error).message);
    }
    if (!event) return { received: true, applied: false };
    const applied = this.service.applyDecision(event.inquiryId, event.status, event.detail);
    if (!applied) this.log.warn(`Persona webhook for unknown inquiry ${event.inquiryId}`);
    return { received: true, applied };
  }
}
