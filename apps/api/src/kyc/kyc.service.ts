import { Inject, Injectable, Optional } from "@nestjs/common";
import { INVESTOR_STORE, InvestorStore, type KycState, type KycStatus } from "../investors/investor.store.js";
import { buildKycProvider, type IKycProvider } from "./kyc.provider.js";

@Injectable()
export class KycService {
  private readonly store: InvestorStore;
  readonly provider: IKycProvider;

  constructor(@Optional() @Inject(INVESTOR_STORE) store?: InvestorStore, @Optional() @Inject("KYC_PROVIDER") provider?: IKycProvider) {
    this.store = store ?? new InvestorStore();
    this.provider = provider ?? buildKycProvider();
  }

  /** Starts (or restarts) verification. Mock approves at once; Persona returns a hosted link. */
  async start(userId: string) {
    const current = this.store.get(userId)?.kyc;
    if (current?.status === "VALID") return { userId, ...current, hostedUrl: null };
    // An open Persona inquiry is resumed with a fresh link rather than duplicated.
    if (current?.inquiryId && current.status === "PENDING" && this.provider.name === current.provider && "oneTimeLink" in this.provider) {
      const link = await (this.provider as unknown as { oneTimeLink(id: string): Promise<string | null> }).oneTimeLink(current.inquiryId);
      if (link) return { userId, ...current, hostedUrl: link };
    }
    const r = await this.provider.start(userId);
    const kyc = this.save(userId, { status: r.status, inquiryId: r.inquiryId, detail: r.detail });
    return { userId, ...kyc, hostedUrl: r.hostedUrl };
  }

  /** Pulls the decision from the provider. Needed locally, where Persona's webhooks cannot reach. */
  async refresh(userId: string) {
    const current = this.store.get(userId)?.kyc;
    if (!current?.inquiryId || current.status !== "PENDING" || !this.provider.fetchStatus) return { userId, ...(current ?? this.pending()) };
    const r = await this.provider.fetchStatus(current.inquiryId);
    return { userId, ...this.save(userId, { status: r.status, inquiryId: current.inquiryId, detail: r.detail }) };
  }

  /** Applies a verified webhook. Returns false when no investor has that inquiry. */
  applyDecision(inquiryId: string, status: KycStatus, detail: string): boolean {
    const investor = this.store.findByInquiry(inquiryId);
    if (!investor) return false;
    // A final decision is not downgraded by a late or out-of-order event.
    if (investor.kyc?.status === "VALID" || investor.kyc?.status === "REJECTED") return true;
    this.save(investor.userId, { status, inquiryId, detail });
    return true;
  }

  state(userId: string): KycState {
    return this.store.get(userId)?.kyc ?? this.pending();
  }

  status(userId: string): KycStatus {
    return this.state(userId).status;
  }

  isValid(userId: string): boolean {
    return this.status(userId) === "VALID";
  }

  private pending(): KycState {
    return { status: "PENDING", provider: this.provider.name, demo: this.provider.demo, inquiryId: null, detail: null, updatedAt: new Date(0).toISOString() };
  }

  private save(userId: string, s: { status: KycStatus; inquiryId: string | null; detail: string | null }): KycState {
    const kyc: KycState = { ...s, provider: this.provider.name, demo: this.provider.demo, updatedAt: new Date().toISOString() };
    this.store.update(userId, (r) => {
      r.kyc = kyc;
    });
    return kyc;
  }
}
