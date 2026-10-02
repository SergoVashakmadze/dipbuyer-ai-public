import type { DecisionRecord, Execution, Fundamentals, RuntimeMode, Understandability } from "@dipbuyer/shared";
import { buildDecisionRecord, evaluate } from "@dipbuyer/strategy";
import type { FundamentalsAdapter, MarketDataAdapter } from "@dipbuyer/data";
import { hashDecision } from "@dipbuyer/chain";
import type { DecisionStore } from "./store.js";

/**
 * The agent orchestration backbone. Composes data → Lynch engine → DecisionRecord → audit hash
 * into one reusable, framework-agnostic flow used by the API, the bot, and scheduled jobs.
 *
 * The LLM reasoning core (PROMPT.md) supplies the understandability narrative; the deterministic
 * engine governs the verdict. Here `understandabilityProvider` is that seam — inject the LLM
 * implementation in production; a default pass-through gate is used otherwise.
 */
export interface DecisionServiceDeps {
  fundamentals: FundamentalsAdapter;
  marketData?: MarketDataAdapter;
  understandabilityProvider?: (symbol: string, f: Fundamentals) => Understandability | Promise<Understandability>;
  /** Stamped into every record for model governance / reproducibility. */
  modelId?: string;
  promptVersion?: string;
  idFactory?: (symbol: string, asOf: string) => string;
  /** Optional audit store — every analysed record is persisted when provided. */
  store?: DecisionStore;
}

export interface AnalyzeOptions {
  mode: RuntimeMode;
  execution: Execution;
  /** Point-in-time clock (ISO). Defaults to "now" via the adapter when omitted. */
  asOf?: string;
  clientId?: string | null;
  tenantId?: string | null;
  /**
   * Persist to the audit store (default true). Bulk read-only research views pass false so a
   * screener refresh does not write one audit record per name per refresh.
   */
  persist?: boolean;
}

export interface AnalyzeOutput {
  record: DecisionRecord;
  /** Deterministic audit hash, ready to anchor on Algorand. */
  hash: string;
}

const defaultGate = (_symbol: string, _f: Fundamentals): Understandability => ({
  passed: true,
  businessSummary: "(placeholder — replace with LLM business summary)",
  growthStory: "(placeholder — replace with LLM growth story)",
});

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  /** Analyse a single symbol and produce a complete, hashable DecisionRecord. */
  async analyze(symbol: string, opts: AnalyzeOptions): Promise<AnalyzeOutput> {
    return (await this.analyzeWithInputs(symbol, opts)).output;
  }

  /**
   * Same as analyze, also returning the fundamentals snapshot the verdict was computed from,
   * so research views can show the inputs behind the decision without a second fetch.
   */
  async analyzeWithInputs(
    symbol: string,
    opts: AnalyzeOptions,
  ): Promise<{ output: AnalyzeOutput; fundamentals: Fundamentals; sourceId: string }> {
    const fundamentals = await this.deps.fundamentals.getFundamentals(symbol, opts.asOf);
    const understandability = await (this.deps.understandabilityProvider ?? defaultGate)(symbol, fundamentals);
    const result = evaluate({ fundamentals, understandability });

    const ts = opts.asOf ?? fundamentals.asOf;
    const record = buildDecisionRecord(result, {
      decisionId: (this.deps.idFactory ?? ((s, t) => `${t}:${s}`))(symbol, ts),
      ts,
      mode: opts.mode,
      execution: opts.execution,
      clientId: opts.clientId ?? null,
      tenantId: opts.tenantId ?? null,
      modelId: this.deps.modelId ?? "deterministic-only",
      promptVersion: this.deps.promptVersion ?? "0.1",
      understandability,
      // Record the ACTUAL source, not a generic label — a signed proof must let a consumer
      // tell real analysis from a demo fixture (see FundamentalsAdapter.sourceId).
      dataProvenance: [
        { field: "fundamentals", source: this.deps.fundamentals.sourceId, asOf: fundamentals.asOf },
      ],
    });

    if (this.deps.store && opts.persist !== false) await this.deps.store.save(record);
    return { output: { record, hash: hashDecision(record) }, fundamentals, sourceId: this.deps.fundamentals.sourceId };
  }

  /** Screen a universe and return only the buy candidates, highest conviction first. */
  async screen(symbols: string[], opts: AnalyzeOptions): Promise<AnalyzeOutput[]> {
    const out: AnalyzeOutput[] = [];
    for (const s of symbols) {
      try {
        out.push(await this.analyze(s, opts));
      } catch {
        // skip symbols with missing/insufficient data (survivorship-safe)
      }
    }
    return out
      .filter((o) => o.record.verdict === "buy")
      .sort((a, b) => b.record.convictionScore - a.record.convictionScore);
  }
}
