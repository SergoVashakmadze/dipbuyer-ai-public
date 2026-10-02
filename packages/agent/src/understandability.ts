import OpenAI from "openai";
import type { Fundamentals, Understandability } from "@dipbuyer/shared";

/**
 * The LLM reasoning core that fills the `understandabilityProvider` seam in DecisionService.
 * Peter Lynch's first rule is "invest in what you know" — a business you can explain in plain
 * English. This provider asks an LLM to (a) judge whether the business is understandable to a
 * generalist investor (the hard gate) and (b) write the plain-English business summary + growth
 * story that ride along in the DecisionRecord (and the x402 proof). The deterministic engine still
 * governs the verdict; this only supplies narrative + the understandability gate.
 *
 * Provider-agnostic: talks the OpenAI-compatible /chat/completions API, so it works with Groq
 * (default), OpenRouter, Google Gemini's OpenAI endpoint, NVIDIA NIM (Nemotron), Zhipu (GLM), a
 * local Ollama, etc. — just point `baseUrl` + `model` + `apiKey` at your provider of choice.
 */
export interface LlmUnderstandabilityConfig {
  apiKey: string;
  /** OpenAI-compatible base URL. Defaults to Groq. */
  baseUrl?: string;
  /** Model id. Defaults to a Groq Llama model — set to whatever your provider currently serves. */
  model?: string;
  /** Injectable for tests. */
  client?: OpenAI;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

const SYSTEM = `You are Peter Lynch analysing a stock. Rule #1: invest in what you know — a business
you can explain in plain English. Given a ticker and its fundamentals, judge whether a generalist
investor could understand how the company makes money (that is the "passed" gate), then write a
plain-English business summary and a concise Lynch-style growth story. Be concrete and specific;
never hedge with "as an AI". Ground the growth story in the numbers provided.

Reply with ONLY a JSON object (no markdown, no prose) of exactly this shape:
{"passed": boolean, "businessSummary": "2-3 sentences on what the company does and how it earns",
 "growthStory": "2-3 sentences on the Lynch growth thesis, or why it's stalled/cyclical"}`;

/** Pull the first balanced JSON object out of model text (tolerates code fences / stray prose). */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** Compact, point-in-time-safe view of the numbers we hand the model. */
function fundamentalsBrief(symbol: string, f: Fundamentals): string {
  const rows: [string, unknown][] = [
    ["symbol", symbol],
    ["asOf", f.asOf],
    ["peRatio", f.peRatio],
    ["epsGrowthPct", f.epsGrowthPct],
    ["dividendYieldPct", f.dividendYieldPct],
    ["debtToEquity", f.debtToEquity],
    ["roePct", f.roePct],
    ["revenueGrowthPct", f.revenueGrowthPct],
    ["marketCapUsd", f.marketCapUsd],
    ["earningsCyclicality", f.earningsCyclicality],
  ];
  return rows
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Build a provider suitable for `DecisionServiceDeps.understandabilityProvider`.
 * Best-effort: if the LLM call fails, it falls back to a permissive gate so a paid/analysis
 * path still returns a record rather than erroring — the deterministic verdict is unaffected.
 */
export function createLlmUnderstandabilityProvider(
  config: LlmUnderstandabilityConfig,
): (symbol: string, f: Fundamentals) => Promise<Understandability> {
  const client =
    config.client ??
    new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl ?? DEFAULT_BASE_URL });
  const model = config.model ?? DEFAULT_MODEL;

  return async (symbol, f) => {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 1024,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Ticker ${symbol}. Fundamentals:\n${fundamentalsBrief(symbol, f)}` },
        ],
      });

      const text = response.choices[0]?.message?.content;
      if (!text) return fallback(symbol, "no narrative returned");
      const parsed = JSON.parse(extractJson(text)) as Understandability;
      return {
        passed: !!parsed.passed,
        businessSummary: parsed.businessSummary,
        growthStory: parsed.growthStory,
      };
    } catch (err) {
      return fallback(symbol, err instanceof Error ? err.message : "unknown error");
    }
  };
}

function fallback(symbol: string, reason: string): Understandability {
  return {
    passed: true,
    businessSummary: `Business summary unavailable for ${symbol} (${reason}).`,
    growthStory: "Growth narrative unavailable; verdict is driven by the deterministic engine.",
  };
}
