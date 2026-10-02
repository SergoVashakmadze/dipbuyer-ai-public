import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { nextRunAt, parseCadence, parseTimeUtc, type AgentRunStore } from "@dipbuyer/agent";
import type { IBroker } from "@dipbuyer/brokers";
import type { MarketDataAdapter } from "@dipbuyer/data";
import { resolveUserId, type AuthedRequest } from "../auth/identity.js";
import { AgentModule } from "../agent/agent.module.js";
import { AGENT_RUN_STORE } from "../agent/agent.service.js";
import { INVESTOR_STORE, InvestorStore } from "../investors/investor.store.js";
import { OrdersModule } from "../orders/orders.module.js";
import { BROKER } from "../orders/orders.providers.js";
import { MARKET_DATA } from "../orders/market-data.provider.js";
import { aggregateInsiders, loadInsiderPurchases } from "../research/insiders.js";
import { ResearchModule } from "../research/research.module.js";
import { RESEARCH_SERVICE } from "../research/research.providers.js";
import type { ResearchService } from "../research/research.service.js";
import { WatchlistModule, WatchlistService } from "../watchlist/watchlist.js";
import { composeDigest, type Digest, type DigestInput } from "./compose.js";

/** Outgoing email. The provider is chosen by EMAIL_PROVIDER; "log" (default) only logs. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe (Gmail/Yahoo expect it on recurring mail). */
  headers?: Record<string, string>;
}
export interface EmailSender {
  readonly id: string;
  send(m: EmailMessage): Promise<void>;
}
export class LogEmailSender implements EmailSender {
  readonly id = "log";
  private readonly log = new Logger("email");
  async send(m: EmailMessage) {
    this.log.log(`[not sent: no EMAIL_PROVIDER] to=${m.to.replace(/(.).*@/, "$1***@")} subject="${m.subject}"`);
  }
}
/**
 * Resend (https://resend.com): EMAIL_PROVIDER=resend, RESEND_API_KEY, EMAIL_FROM ("DipBuyer
 * <digest@dipbuyer.ai>", on a domain verified in Resend). One request per message.
 */
export class ResendEmailSender implements EmailSender {
  readonly id = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(m: EmailMessage) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.headers ? { headers: m.headers } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

/**
 * Cloudflare Email Service REST API: EMAIL_PROVIDER=cloudflare, CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_EMAIL_API_TOKEN (email sending permission), EMAIL_FROM on a domain onboarded with
 * `wrangler email sending enable`. Cloudflare positions this for TRANSACTIONAL mail; use Resend for
 * the newsletter-style digest (see docs/DEPLOY-API.md).
 */
export class CloudflareEmailSender implements EmailSender {
  readonly id = "cloudflare";
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(m: EmailMessage) {
    // "Name <addr>" -> { address, name }; the REST API uses `address`, not `email`.
    const fm = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(this.from);
    const res = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/email/sending/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fm ? { address: fm[2], name: fm[1] } : this.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.headers ? { headers: m.headers } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ message?: string }>; result?: { permanent_bounces?: string[] } } | null;
    if (!res.ok || body?.success === false) throw new Error(`Cloudflare email: HTTP ${res.status} ${body?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
    if (body?.result?.permanent_bounces?.length) throw new Error(`Cloudflare email: permanent bounce for ${m.to.replace(/(.).*@/, "$1***@")}`);
  }
}

/** Chosen by EMAIL_PROVIDER. A provider named but not configured fails at boot, not silently at send time. */
export function emailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const provider = (env.EMAIL_PROVIDER ?? "log").trim().toLowerCase();
  if (provider === "" || provider === "log") return new LogEmailSender();
  if (provider === "resend") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM");
    return new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  if (provider === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_EMAIL_API_TOKEN || !env.EMAIL_FROM) {
      throw new Error("EMAIL_PROVIDER=cloudflare needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN and EMAIL_FROM");
    }
    return new CloudflareEmailSender(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_EMAIL_API_TOKEN, env.EMAIL_FROM);
  }
  throw new Error(`EMAIL_PROVIDER="${env.EMAIL_PROVIDER}" is not one of: log, resend, cloudflare`);
}

export const EMAIL_SENDER = "EMAIL_SENDER";

const WEEK_MS = 7 * 86_400_000;
/** The digest page is where the investor switches it off (sign-in required). */
const unsubscribeHeaders = () => ({ "List-Unsubscribe": `<${process.env.APP_URL ?? "https://dipbuyer.ai"}/digest>` });

@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("digest");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(INVESTOR_STORE) private readonly investors: InvestorStore,
    @Inject(BROKER) private readonly broker: IBroker,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataAdapter,
    @Inject(AGENT_RUN_STORE) private readonly runs: AgentRunStore,
    @Inject(RESEARCH_SERVICE) private readonly research: ResearchService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly watchlist: WatchlistService,
  ) {}

  /** DIGEST_SCHEDULE=weekly (plus DIGEST_TIME_UTC, default 07:00) sends to opted-in investors. Off by default. */
  onModuleInit() {
    const cadence = parseCadence(process.env.DIGEST_SCHEDULE);
    if (cadence === "off") return;
    const arm = () => {
      const at = nextRunAt(cadence, parseTimeUtc(process.env.DIGEST_TIME_UTC ?? "07:00"), new Date());
      if (!at) return;
      const wait = Math.min(at.getTime() - Date.now(), 24 * 3_600_000); // re-arm at least daily (setTimeout limit)
      this.timer = setTimeout(async () => {
        if (Date.now() >= at.getTime() - 1_000) await this.sendAll().catch((e) => this.log.error((e as Error).message));
        arm();
      }, Math.max(1_000, wait));
    };
    arm();
  }
  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  async build(userId: string): Promise<Digest> {
    const since = Date.now() - WEEK_MS;
    const record = this.investors.get(userId);

    // The paper account is shared, so portfolio and agent sections come from the one broker book.
    const positions = await this.broker.getPositions().catch(() => []);
    let equity = await this.broker.getCash().catch(() => 0);
    const cash = equity;
    let unrealized = 0;
    for (const p of positions) {
      const px = await this.marketData.getLatestPrice(p.symbol).catch(() => p.avgEntryPrice);
      equity += p.qty * px;
      unrealized += p.qty * (px - p.avgEntryPrice);
    }
    const runs = (await this.runs.recent(100)).filter((r) => Date.parse(r.startedAt) >= since);

    const alerts = this.watchlist.store.alerts(userId).filter((a) => Date.parse(a.at) >= since).slice(0, 10);
    const screener = await this.research.screener().catch(() => null);
    const buys = (screener?.rows ?? [])
      .filter((r) => r.verdict === "buy")
      .sort((a, b) => b.convictionScore - a.convictionScore)
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, convictionScore: r.convictionScore, upside: r.upside, drawdown: r.drawdown }));
    const insiders = aggregateInsiders(loadInsiderPurchases().rows, new Date(since).toISOString().slice(0, 10), 100_000)
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, 5);

    const input: DigestInput = {
      name: record?.profile?.fullName ?? null,
      weekEnding: new Date().toISOString().slice(0, 10),
      appUrl: process.env.APP_URL ?? "https://dipbuyer.ai",
      portfolio: positions.length || cash ? { equity, cash, positions: positions.length, unrealized } : null,
      agent: { runs: runs.length, ordersPlaced: runs.reduce((t, r) => t + r.proposals.filter((p) => p.status === "placed").length, 0), lastRunAt: runs[0]?.startedAt ?? null },
      alerts: alerts.map((a) => ({ symbol: a.symbol, kind: a.kind, message: a.message, at: a.at })),
      buys,
      insiders: insiders.map((c) => ({ ticker: c.ticker, company: c.company, totalUsd: c.totalUsd, insiders: c.insiders, topExecutiveBought: c.topExecutiveBought })),
    };
    return composeDigest(input);
  }

  /** Every opted-in investor with an email, at most once per 6 days each. */
  async sendAll(): Promise<{ sent: number; skipped: number }> {
    let sent = 0, skipped = 0;
    for (const inv of this.investors.all()) {
      const last = inv.digest?.lastSentAt;
      if (!inv.email || !inv.digest?.optIn || (last && Date.now() - Date.parse(last) < 6 * 86_400_000)) {
        skipped++;
        continue;
      }
      const d = await this.build(inv.userId);
      await this.email.send({ to: inv.email, ...d, headers: unsubscribeHeaders() });
      this.investors.update(inv.userId, (r) => void (r.digest = { optIn: true, updatedAt: r.digest?.updatedAt ?? new Date().toISOString(), lastSentAt: new Date().toISOString() }));
      sent++;
    }
    this.log.log(`weekly digest: ${sent} sent via ${this.email.id}, ${skipped} skipped`);
    return { sent, skipped };
  }
}

/**
 * GET  /digest/preview          this week's digest for you (subject, html, text) + your subscription
 * PUT  /digest/subscription     { optIn: boolean }
 * POST /digest/send-test        send this week's digest to your own email now
 */
@Controller("digest")
export class DigestController {
  constructor(
    private readonly digest: DigestService,
    @Inject(INVESTOR_STORE) private readonly investors: InvestorStore,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  @Get("preview")
  async preview(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    const rec = this.investors.get(userId);
    return { ...(await this.digest.build(userId)), optIn: rec?.digest?.optIn ?? false, email: rec?.email ?? null, provider: this.email.id };
  }

  @Put("subscription")
  subscribe(@Body() body: { optIn?: boolean }, @Req() req?: AuthedRequest) {
    if (typeof body?.optIn !== "boolean") throw new BadRequestException("optIn must be true or false");
    const userId = resolveUserId(req);
    const rec = this.investors.update(userId, (r) => void (r.digest = { ...(r.digest ?? {}), optIn: body.optIn!, updatedAt: new Date().toISOString() }));
    return { optIn: rec.digest?.optIn ?? false };
  }

  @Post("send-test")
  async sendTest(@Req() req?: AuthedRequest) {
    const userId = resolveUserId(req);
    const to = this.investors.get(userId)?.email;
    if (!to) throw new BadRequestException("No email address on your account. Sign in with an email-based login first.");
    await this.email.send({ to, ...(await this.digest.build(userId)), headers: unsubscribeHeaders() });
    return { sentTo: to, provider: this.email.id };
  }
}

@Module({
  imports: [OrdersModule, AgentModule, ResearchModule, WatchlistModule],
  controllers: [DigestController],
  providers: [DigestService, { provide: EMAIL_SENDER, useFactory: (): EmailSender => emailSenderFromEnv() }],
  exports: [DigestService, EMAIL_SENDER],
})
export class DigestModule {}
