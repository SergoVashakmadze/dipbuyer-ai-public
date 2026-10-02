import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator.js";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  health() {
    return {
      ok: true,
      mode: process.env.RUNTIME_MODE ?? "RESEARCH_ONLY",
      execution: process.env.RUNTIME_EXECUTION ?? "PAPER",
      // Configured source only. A key being PRESENT does not mean data is FLOWING — the
      // account can be out of credits (HTTP 402) or the key revoked, and this endpoint must
      // not imply real data on that basis. `/health/data` probes for real.
      fundamentals: process.env.FINANCIALDATASETS_API_KEY
        ? "financialdatasets.ai"
        : process.env.SEC_EDGAR_USER_AGENT
          ? "sec-edgar"
          : "in-memory-demo",
      fundamentalsVerified: false,
    };
  }

  /**
   * Live probe of the fundamentals provider — the only honest answer to "is this real data?".
   * Kept off /health because it costs an upstream call.
   */
  @Public()
  @Get("data")
  async data() {
    const key = process.env.FINANCIALDATASETS_API_KEY;
    if (!key) {
      const ua = process.env.SEC_EDGAR_USER_AGENT;
      if (!ua) {
        return {
          source: "in-memory-demo",
          reachable: false,
          reason: "no fundamentals source configured (set FINANCIALDATASETS_API_KEY or SEC_EDGAR_USER_AGENT)",
        };
      }
      try {
        // Cheapest real probe: one concept for a known CIK (Apple).
        const res = await fetch(
          "https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/EarningsPerShareDiluted.json",
          { headers: { "User-Agent": ua, Accept: "application/json" } },
        );
        return {
          source: "sec-edgar",
          reachable: res.ok,
          reason: res.ok
            ? null
            : res.status === 403
              ? "SEC rejected the request — SEC_EDGAR_USER_AGENT must identify you (name + contact)"
              : `HTTP ${res.status}`,
        };
      } catch (e) {
        return { source: "sec-edgar", reachable: false, reason: (e as Error).message };
      }
    }
    try {
      const res = await fetch("https://api.financialdatasets.ai/financial-metrics?ticker=AAPL&limit=1", {
        headers: { "X-API-KEY": key },
      });
      if (res.ok) return { source: "financialdatasets.ai", reachable: true, reason: null };
      const reason =
        res.status === 402
          ? "insufficient credits — analysis will fail, not silently fall back to demo data"
          : `HTTP ${res.status}`;
      return { source: "financialdatasets.ai", reachable: false, reason };
    } catch (e) {
      return { source: "financialdatasets.ai", reachable: false, reason: (e as Error).message };
    }
  }

  /** Readiness probe (k8s/Docker): reports dependency configuration. */
  @Public()
  @Get("ready")
  ready() {
    return {
      ready: true,
      persistence: process.env.DATABASE_URL ? "postgres" : "in-memory",
      marketData: process.env.ALPACA_KEY_ID ? "alpaca" : "demo",
      auth: process.env.AUTH0_DOMAIN ? "auth0" : "open",
    };
  }
}
