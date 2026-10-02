/**
 * Visible warning that a verdict was computed from demo fixtures rather than real market data.
 *
 * Provenance lives in DecisionRecord.dataProvenance, but a field buried in JSON is not a
 * disclosure — a user reading "BUY, conviction 82" has no reason to suspect the numbers are
 * invented. This puts it next to the verdict it qualifies.
 */
export function DemoDataBanner({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="demo-banner" role="status">
      <strong>Demo data — not a real analysis.</strong> This verdict was computed from synthetic
      fixtures ({sources.join(", ")}), not live fundamentals. The figures do not describe the real
      company. Configure <span className="mono">FINANCIALDATASETS_API_KEY</span> for real data.
    </div>
  );
}
