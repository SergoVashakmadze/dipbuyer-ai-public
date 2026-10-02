import { BadRequestException, Body, Controller, Get, Inject, Post, Put, Req } from "@nestjs/common";
import { emailOf, resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { emailFromAuth0 } from "../auth/userinfo.js";
import { INVESTOR_STORE, InvestorStore } from "../investors/investor.store.js";
import { KycService } from "../kyc/kyc.service.js";
import { SuitabilityService, type SuitabilityInput } from "../suitability/suitability.service.js";

const COUNTRY = /^[A-Z]{2}$/;

/**
 * The signed-in investor's onboarding: profile -> identity verification -> suitability. Everything
 * is keyed by the Auth0 subject; there is no userId parameter to tamper with.
 */
@Controller("onboarding/me")
export class OnboardingController {
  constructor(
    @Inject(INVESTOR_STORE) private readonly store: InvestorStore,
    private readonly kyc: KycService,
    private readonly suitability: SuitabilityService,
  ) {}

  @Get()
  async me(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    const email = emailOf(req) ?? (req ? await emailFromAuth0(req) : null);
    if (email && this.store.get(userId)?.email !== email) this.store.update(userId, (r) => void (r.email = email));
    return this.view(userId);
  }

  @Put("profile")
  profile(@Body() body: { fullName?: string; countryOfResidence?: string }, @Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    const fullName = (body?.fullName ?? "").trim();
    const country = (body?.countryOfResidence ?? "").trim().toUpperCase();
    if (fullName.length < 2 || fullName.length > 120) throw new BadRequestException("Enter your full legal name");
    if (!COUNTRY.test(country)) throw new BadRequestException("Choose your country of residence");
    this.store.update(userId, (r) => {
      r.profile = { fullName, countryOfResidence: country };
    });
    return this.view(userId);
  }

  @Post("identity/start")
  async startIdentity(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    if (!this.store.get(userId)?.profile) throw new BadRequestException("Complete your details first");
    const started = await this.kyc.start(userId);
    return { ...this.view(userId), hostedUrl: started.hostedUrl };
  }

  @Post("identity/refresh")
  async refreshIdentity(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    await this.kyc.refresh(userId);
    return this.view(userId);
  }

  @Post("suitability")
  assess(@Body() body: Omit<SuitabilityInput, "userId">, @Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    if (this.kyc.status(userId) !== "VALID") throw new BadRequestException("Verify your identity before the suitability assessment");
    if (!body?.riskTolerance || !body?.capacityForLoss || !body?.knowledgeExperience || !body?.investmentHorizon || !body?.objectives) {
      throw new BadRequestException("Answer every question");
    }
    this.suitability.assess({ ...body, userId });
    return this.view(userId);
  }

  private view(userId: string) {
    const r = this.store.get(userId);
    const kyc = this.kyc.state(userId);
    const steps = {
      profile: r?.profile ? "done" : "todo",
      identity: kyc.status === "VALID" ? "done" : kyc.status === "REJECTED" ? "rejected" : kyc.inquiryId ? "in_review" : "todo",
      suitability: r?.suitability ? (r.suitability.status === "VALID" ? "done" : "unsuitable") : "todo",
    } as const;
    return {
      userId,
      email: r?.email ?? null,
      profile: r?.profile ?? null,
      kyc,
      suitability: r?.suitability ?? null,
      steps,
      complete: steps.profile === "done" && steps.identity === "done" && steps.suitability === "done",
      identityProvider: { name: this.kyc.provider.name, demo: this.kyc.provider.demo },
    };
  }
}
