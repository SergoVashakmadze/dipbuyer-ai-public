import type { Criterion, DecisionRecord } from "../lib/api";

const VERDICT_LABEL: Record<string, string> = {
  buy: "Buy",
  hold: "Hold",
  trim: "Trim",
  sell: "Sell",
  avoid: "Avoid",
  abstain: "No verdict",
};

/** Verdict pill: colour, dot AND label, never colour alone (DESIGN.md §8). */
export function VerdictBadge({ verdict, large = false }: { verdict: string; large?: boolean }) {
  return <span className={`badge ${verdict}${large ? " lg" : ""}`}>{VERDICT_LABEL[verdict] ?? verdict}</span>;
}

export function ConvictionGauge({ score }: { score: number }) {
  const color = score >= 70 ? "var(--success)" : score >= 40 ? "#f59e0b" : "var(--danger)";
  return (
    <div>
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <span>Conviction</span>
        <b className="mono">{score}<span className="faint">/100</span></b>
      </div>
      <div className="gauge">
        <div style={{ width: `${score}%`, background: color }} />
      </div>
    </div>
  );
}

/** Plain-English names and one-line explanations for the engine's criterion ids. */
const CRITERIA_TEXT: Record<string, [string, string]> = {
  PEG: ["PEG ratio", "P/E divided by earnings growth; Lynch buys at 1 or below"],
  PEGY: ["Dividend-adjusted PEG", "P/E divided by (growth + dividend yield)"],
  value_trap_guard: ["Value-trap guard", "A cheap stock must also generate free cash flow"],
  debt_to_equity: ["Debt to equity", "Lynch wants a conservatively financed balance sheet"],
  inventory_vs_sales: ["Inventory vs sales", "Inventory growing faster than sales is a red flag"],
  growth_consistency: ["Growth consistency", "Years of rising earnings, not one lucky year"],
  roe: ["Return on equity", "How much profit each $ of equity earns"],
  fcf_positive: ["Free cash flow", "The business funds itself"],
  dividend_yield: ["Dividend yield", "Slow growers are bought for the dividend"],
  dividend_cover: ["Dividend cover", "Earnings must comfortably pay the dividend"],
  cycle_position: ["Cycle position", "Buy cyclicals when earnings are depressed, not at the peak"],
  insider_buying: ["Insider buying", "Executives buying their own stock"],
  institutional_ownership: ["Institutional ownership", "Below-median ownership: Wall Street hasn't found it yet"],
  asset_value_ratio: ["Hidden asset value", "Assets worth well above the market cap"],
  net_cash_floor: ["Net cash", "Cash above debt puts a floor under the price"],
  f_score: ["Piotroski F-score", "Nine accounting signals of improving health"],
};

const isBigNumber = (v: number): boolean => Math.abs(v) >= 1e5;

function formatCriterionValue(name: string, value: Criterion["value"]): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  if (isBigNumber(value)) {
    const a = Math.abs(value);
    const s = a >= 1e9 ? `$${(value / 1e9).toFixed(1)}B` : `$${(value / 1e6).toFixed(0)}M`;
    return s;
  }
  if (name === "roe" || name === "dividend_yield") return `${value.toFixed(1)}%`;
  if (name === "dividend_cover" || name === "debt_to_equity") return `${value.toFixed(2)}x`;
  return String(Math.round(value * 100) / 100);
}

const prettyThreshold = (t: string) => t.replace(/<=/g, "≤ ").replace(/>=/g, "≥ ").replace(/D\/E/g, "debt/equity");

/**
 * One sentence on why the verdict is what it is. A hard reject scores 0 whatever else passes, which
 * read as a contradiction ("4/6 passed, conviction 0") until it was spelled out.
 */
export function VerdictExplainer({ record }: { record: DecisionRecord }) {
  const reject = record.criteria.find((c) => c.note?.startsWith("REJECT"));
  const scored = record.criteria.filter((c) => c.result !== "na" && c.weight > 0);
  const passed = scored.filter((c) => c.result === "pass").length;
  const category = record.lynchCategory?.replace(/_/g, " ");
  let text: string;
  if (record.verdict === "abstain") text = `No verdict: ${record.abstainReason?.replace(/^insufficient_data:\s*/, "not enough data — ") ?? "not enough data"}.`;
  else if (reject) {
    const [label] = CRITERIA_TEXT[reject.name] ?? [reject.name];
    text = `Rejected outright: ${label.toLowerCase()} of ${formatCriterionValue(reject.name, reject.value)} breaks a hard limit (${prettyThreshold(reject.note!.replace(/^REJECT:\s*/, ""))}), so the score is 0 whatever else passes.`;
  } else
    text = `${passed} of ${scored.length} weighted criteria pass for a ${category ?? "stock"}, scoring ${record.convictionScore}/100. A buy needs 70 or more.`;
  return (
    <p className="verdict-explainer">
      <VerdictBadge verdict={record.verdict} large />
      <span>{text}</span>
    </p>
  );
}

export function CriteriaList({ criteria }: { criteria: Criterion[] }) {
  if (!criteria.length) return null;
  return (
    <ul className="criteria">
      {criteria.map((c, i) => {
        const [label, help] = CRITERIA_TEXT[c.name] ?? [c.name.replace(/_/g, " "), ""];
        const cls = c.result === "pass" ? "ok" : c.result === "fail" ? "no" : "na";
        return (
          <li key={i} className="crit-row">
            <span className={`crit-icon ${cls}`} aria-label={c.result === "pass" ? "passes" : c.result === "fail" ? "fails" : "not applicable"}>
              {c.result === "pass" ? "✓" : c.result === "fail" ? "✕" : "–"}
            </span>
            <span>
              <span className="crit-name">{label}</span>
              {help && <span className="crit-help">{help}</span>}
              {c.note?.startsWith("REJECT") && <span className="crit-help" style={{ color: "var(--danger)", fontWeight: 600 }}>Hard limit breached: {prettyThreshold(c.note.replace(/^REJECT:\s*/, ""))}</span>}
            </span>
            <span className="crit-value">
              <b className="mono">{formatCriterionValue(c.name, c.value)}</b>
              <small>{c.result === "na" ? "not applicable" : `target ${prettyThreshold(c.threshold)}`}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function DecisionCard({ record, hash }: { record: DecisionRecord; hash: string }) {
  return (
    <div className="card">
      <div className="head">
        <a className="symbol" href={`/decision/${record.symbol}`}>
          {record.symbol}
        </a>
        <VerdictBadge verdict={record.verdict} />
      </div>
      <div className="kv" style={{ marginTop: 6 }}>
        <span>Category</span>
        <b>{record.lynchCategory ?? "—"}</b>
      </div>
      <ConvictionGauge score={record.convictionScore} />
      <p className="rationale">{record.rationale}</p>
      <CriteriaList criteria={record.criteria} />
      <div className="kv" style={{ marginTop: 10, fontSize: "0.72rem" }} title="Audit hash — anchorable on Algorand">
        <span>🔗 audit</span>
        <b className="mono">{hash.slice(0, 18)}…</b>
      </div>
    </div>
  );
}
