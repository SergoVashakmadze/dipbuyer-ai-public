import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Investor onboarding records (profile, identity verification, suitability), keyed by the Auth0
 * subject. Before 2026-09-17 KYC and suitability lived in two in-memory Maps, so every API restart
 * silently un-onboarded everyone and blocked their trades.
 *
 * File-backed JSON (atomic write, owner-only permissions) until Postgres is wired: the Prisma schema
 * already has User.kycStatus and Suitability, and this record maps onto them. Holds personal data:
 * keep the file out of the repo (default apps/api/.data/, gitignored) and off shared disks.
 */
export type KycStatus = "PENDING" | "VALID" | "REJECTED";

export interface InvestorProfile {
  fullName: string;
  countryOfResidence: string;
}

export interface KycState {
  status: KycStatus;
  provider: string;
  /** True when no real identity check happened (mock provider). */
  demo: boolean;
  inquiryId: string | null;
  /** Provider status or reason in plain English, e.g. "Persona: needs_review". */
  detail: string | null;
  updatedAt: string;
}

export interface SuitabilityState {
  objectives: string;
  riskTolerance: "low" | "medium" | "high";
  capacityForLoss: "low" | "medium" | "high";
  knowledgeExperience: "none" | "basic" | "informed" | "expert";
  investmentHorizon: "lt3" | "3to5" | "5to10" | "gt10";
  exclusions: string[];
  /** VALID = assessed and suitable; UNSUITABLE = assessed, and the service must not be provided. */
  status: "VALID" | "UNSUITABLE";
  reasons: string[];
  /** Risks the investor was warned about and explicitly acknowledged (not blockers). */
  warnings: string[];
  riskAcknowledgedAt: string | null;
  assessedAt: string;
}

export interface InvestorRecord {
  userId: string;
  email: string | null;
  profile: InvestorProfile | null;
  kyc: KycState | null;
  suitability: SuitabilityState | null;
  /** Weekly digest email consent (PECR: marketing email needs opt-in). Absent = not subscribed. */
  digest?: { optIn: boolean; updatedAt: string; lastSentAt?: string };
  createdAt: string;
  updatedAt: string;
}

export const INVESTOR_STORE = "INVESTOR_STORE";

export class InvestorStore {
  private records = new Map<string, InvestorRecord>();

  /** No path = in memory only (tests). */
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as InvestorRecord[];
      if (Array.isArray(parsed)) this.records = new Map(parsed.map((r) => [r.userId, r]));
    } catch {
      this.records = new Map(); // no file yet
    }
  }

  get(userId: string): InvestorRecord | null {
    const r = this.records.get(userId);
    return r ? structuredClone(r) : null;
  }

  all(): InvestorRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  findByInquiry(inquiryId: string): InvestorRecord | null {
    for (const r of this.records.values()) if (r.kyc?.inquiryId === inquiryId) return structuredClone(r);
    return null;
  }

  update(userId: string, patch: (r: InvestorRecord) => void): InvestorRecord {
    const now = new Date().toISOString();
    const current = this.records.get(userId) ?? { userId, email: null, profile: null, kyc: null, suitability: null, createdAt: now, updatedAt: now };
    const next = structuredClone(current);
    patch(next);
    next.updatedAt = now;
    this.records.set(userId, next);
    this.persist();
    return structuredClone(next);
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
  }
}
