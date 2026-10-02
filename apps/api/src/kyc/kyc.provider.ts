import { createHmac, timingSafeEqual } from "node:crypto";
import type { KycStatus } from "../investors/investor.store.js";

export type { KycStatus };

/**
 * Identity verification providers. A third-party check does NOT discharge the firm's own MLR 2017
 * duties (the product requirements): a full AML programme (CDD/EDD, PEP and sanctions, ongoing monitoring, MLRO) is a
 * separate pre-live workstream.
 *
 *  - persona  real document + selfie verification via Persona's hosted flow (withpersona.com)
 *  - mock     approves instantly; for local development only and always labelled "demo"
 *  - entrust  placeholder, not implemented
 */
export interface KycStart {
  status: KycStatus;
  inquiryId: string | null;
  /** Where the investor completes verification (Persona one-time link). */
  hostedUrl: string | null;
  detail: string | null;
}

export interface IKycProvider {
  readonly name: string;
  readonly demo: boolean;
  start(userId: string): Promise<KycStart>;
  /** Current decision for an inquiry, straight from the provider (no webhook needed). */
  fetchStatus?(inquiryId: string): Promise<{ status: KycStatus; detail: string }>;
  /** Verifies a signed webhook and extracts the decision; throws on a bad signature. */
  parseWebhook?(rawBody: string, signatureHeader: string | undefined, now?: number): { inquiryId: string; status: KycStatus; detail: string } | null;
}

export class MockKycProvider implements IKycProvider {
  readonly name = "mock";
  readonly demo = true;
  async start(): Promise<KycStart> {
    return { status: "VALID", inquiryId: null, hostedUrl: null, detail: "Demo verification: no identity documents were checked" };
  }
}

export class EntrustKycProvider implements IKycProvider {
  readonly name = "entrust";
  readonly demo = false;
  async start(): Promise<KycStart> {
    throw new Error("Entrust IDV not yet implemented");
  }
}

/** Persona inquiry status -> our gate. Only an explicit approval unlocks trading. */
export function mapPersonaStatus(status: string | undefined): { status: KycStatus; detail: string } {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "approved") return { status: "VALID", detail: "Persona: approved" };
  if (s === "declined" || s === "failed") return { status: "REJECTED", detail: `Persona: ${s}` };
  return { status: "PENDING", detail: `Persona: ${s.replace(/_/g, " ")}` };
}

/** Replay window for signed webhooks, as Stripe and most signers use. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Ported from IoMarkets 3.0 (apps/api/src/modules/kyc/providers/persona-kyc.provider.ts), without
 * its Prisma/email/notification coupling. Persona API version pinned to 2023-01-05; validate the
 * shapes against Persona's current docs before go-live.
 */
export class PersonaKycProvider implements IKycProvider {
  readonly name = "persona";
  readonly demo = false;
  private readonly base: string;

  constructor(
    private readonly opts: { apiKey: string; templateId: string; webhookSecret?: string; baseUrl?: string; fetchImpl?: typeof fetch },
  ) {
    this.base = opts.baseUrl ?? "https://api.withpersona.com/api/v1";
  }

  private headers() {
    return { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", "Persona-Version": "2023-01-05" };
  }

  private get http() {
    return this.opts.fetchImpl ?? fetch;
  }

  async start(userId: string): Promise<KycStart> {
    const res = await this.http(`${this.base}/inquiries`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ data: { attributes: { "inquiry-template-id": this.opts.templateId, "reference-id": userId } } }),
    });
    if (!res.ok) throw new Error(`Persona could not start verification (HTTP ${res.status})`);
    const inquiryId = ((await res.json()) as { data?: { id?: string } }).data?.id;
    if (!inquiryId) throw new Error("Persona returned no inquiry id");
    return { status: "PENDING", inquiryId, hostedUrl: await this.oneTimeLink(inquiryId), detail: "Persona: created" };
  }

  /** A fresh single-use link for an existing inquiry (links expire; never store them). */
  async oneTimeLink(inquiryId: string): Promise<string | null> {
    try {
      const res = await this.http(`${this.base}/inquiries/${encodeURIComponent(inquiryId)}/generate-one-time-link`, { method: "POST", headers: this.headers() });
      if (!res.ok) return null;
      return ((await res.json()) as { meta?: Record<string, string> }).meta?.["one-time-link"] ?? null;
    } catch {
      return null; // recoverable: the inquiry exists, the investor can ask for a new link
    }
  }

  async fetchStatus(inquiryId: string) {
    const res = await this.http(`${this.base}/inquiries/${encodeURIComponent(inquiryId)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Persona status check failed (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: { attributes?: { status?: string } } };
    return mapPersonaStatus(body.data?.attributes?.status);
  }

  parseWebhook(rawBody: string, signatureHeader: string | undefined, now = Date.now()) {
    // Fail closed: the webhook route is public, so an unconfigured secret must reject, never skip.
    if (!this.opts.webhookSecret) throw new Error("Webhook signature verification is not configured");
    if (!signatureHeader) throw new Error("Missing webhook signature");
    // "t=<ts>,v1=<hmac>[ <hmac2>]" — several v1 values while a secret is being rotated.
    const fields = new Map<string, string[]>();
    for (const part of signatureHeader.split(",")) {
      const [k, ...rest] = part.trim().split("=");
      if (k && rest.length) fields.set(k, [...(fields.get(k) ?? []), ...rest.join("=").split(" ")]);
    }
    const t = fields.get("t")?.[0];
    const sigs = fields.get("v1") ?? [];
    if (!t || sigs.length === 0 || !Number.isFinite(Number(t))) throw new Error("Malformed webhook signature");
    if (Math.abs(now / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SECONDS) throw new Error("Webhook timestamp outside tolerance");
    const expected = Buffer.from(createHmac("sha256", this.opts.webhookSecret).update(`${t}.${rawBody}`).digest("hex"), "hex");
    const ok = sigs.some((s) => {
      const got = Buffer.from(s, "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    if (!ok) throw new Error("Invalid webhook signature");

    // Shape-tolerant on purpose: the account picks the webhook API version (2023-01-05 … 2025-12-08),
    // and newer versions may carry the inquiry in `payload.included` rather than `payload.data`.
    // We only need the inquiry's id and status, so find the inquiry object wherever it sits.
    const payload = JSON.parse(rawBody) as PersonaEvent;
    const attrs = payload.data?.attributes;
    const name = attrs?.name ?? attrs?.["event-name"] ?? attrs?.event_name;
    if (typeof name !== "string" || !name.startsWith("inquiry.")) return null; // other events are acknowledged and ignored
    const candidates = [attrs?.payload?.data, ...(attrs?.payload?.included ?? [])].filter(Boolean) as PersonaResource[];
    const inquiry = candidates.find((r) => r?.type === "inquiry" && r?.attributes?.status) ?? candidates.find((r) => r?.attributes?.status);
    const inquiryId = inquiry?.id;
    const status = inquiry?.attributes?.status;
    if (!inquiryId || !status) return null;
    return { inquiryId, ...mapPersonaStatus(status) };
  }
}

interface PersonaResource {
  id?: string;
  type?: string;
  attributes?: { status?: string };
}
interface PersonaEvent {
  data?: {
    attributes?: {
      name?: string;
      "event-name"?: string;
      event_name?: string;
      payload?: { data?: PersonaResource; included?: PersonaResource[] };
    };
  };
}

/** KYC_PROVIDER wins when set; otherwise Persona when its keys exist, else the demo mock. */
export function buildKycProvider(env: NodeJS.ProcessEnv = process.env): IKycProvider {
  const persona = () =>
    new PersonaKycProvider({ apiKey: env.PERSONA_API_KEY ?? "", templateId: env.PERSONA_TEMPLATE_ID ?? "", webhookSecret: env.PERSONA_WEBHOOK_SECRET, baseUrl: env.PERSONA_API_BASE || undefined });
  switch ((env.KYC_PROVIDER ?? "").toLowerCase()) {
    case "persona":
      return persona();
    case "entrust":
      return new EntrustKycProvider();
    case "mock":
      return new MockKycProvider();
    default:
      return env.PERSONA_API_KEY && env.PERSONA_TEMPLATE_ID ? persona() : new MockKycProvider();
  }
}
