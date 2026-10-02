"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ScreenerRow } from "../lib/api";
import { VerdictBadge } from "./decision-ui";
import { IconSearch } from "./icons";

// ---------------------------------------------------------------------------
// Formatting. Numbers render in the tabular mono face (DESIGN.md §3); missing data is an
// em dash, never a zero.

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
export const DASH = "—";

const HUES = ["hue-violet", "hue-sky", "hue-emerald", "hue-amber", "hue-rose"] as const;
/** A stable accent hue per ticker, so company logos are told apart at a glance. */
export const hueFor = (symbol: string) => HUES[[...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]!;

export const money = (v: number | null | undefined) =>
  isNum(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 }) : DASH;

export const bigMoney = (v: number | null | undefined) => {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return money(v);
};

/** Fraction in: 0.123 -> "12.3%". */
export const frac = (v: number | null | undefined, signed = false) =>
  isNum(v) ? `${signed && v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : DASH;

/** Whole percent in: 12.3 -> "12.3%". */
export const pct = (v: number | null | undefined) => (isNum(v) ? `${v.toFixed(1)}%` : DASH);

export const ratio = (v: number | null | undefined, digits = 2) => (isNum(v) ? `${v.toFixed(digits)}x` : DASH);

export const score10 = (v: number | null | undefined) => (isNum(v) ? v.toFixed(1) : DASH);

export const signColor = (v: number | null | undefined) =>
  !isNum(v) || v === 0 ? "var(--text-muted)" : v > 0 ? "var(--success)" : "var(--danger)";

export const scoreColor = (v: number | null | undefined) =>
  !isNum(v) ? "var(--neutral)" : v >= 7 ? "var(--success)" : v >= 5 ? "var(--warning)" : "var(--danger)";

// ---------------------------------------------------------------------------
// Gauges.

/** Half-ring 0-10 gauge for the quality profile. */
export function QualityGauge({ value }: { value: number | null }) {
  const half = Math.PI * 70;
  const filled = isNum(value) ? (value / 10) * half : 0;
  return (
    <div className="q-gauge" role="img" aria-label={`Quality profile ${score10(value)} out of 10`}>
      <svg viewBox="0 0 180 100">
        <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="var(--bg-subtle)" strokeWidth="16" strokeLinecap="round" />
        <path
          d="M 20 90 A 70 70 0 0 1 160 90"
          fill="none"
          stroke={scoreColor(value)}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${half}`}
          style={{ transition: "stroke-dasharray 600ms ease-out" }}
        />
      </svg>
      <div className="q-gauge-value mono" style={{ color: scoreColor(value) }}>
        {score10(value)}
      </div>
    </div>
  );
}

export function PillarRing({ value, label }: { value: number | null; label: string }) {
  const c = 2 * Math.PI * 14;
  const filled = isNum(value) ? (value / 10) * c : 0;
  return (
    <div className="pillar">
      <svg viewBox="0 0 36 36" width="36" height="36" style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <circle cx="18" cy="18" r="14" fill="none" stroke="var(--bg-subtle)" strokeWidth="3.5" />
        <circle cx="18" cy="18" r="14" fill="none" stroke={scoreColor(value)} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${filled} ${c}`} />
      </svg>
      <span className="mono pillar-value" style={{ color: scoreColor(value) }}>
        {score10(value)}
      </span>
      <span>{label}</span>
    </div>
  );
}

/** Where the price sits in its 52-week range. */
export function RangeBar({ low, high, position }: { low: number; high: number; position: number | null }) {
  return (
    <div>
      <div className="range-labels mono">
        <span>52w low {money(low)}</span>
        <span>52w high {money(high)}</span>
      </div>
      <div className="range-track">
        {isNum(position) && <div className="range-marker" style={{ left: `${position * 100}%` }} aria-label="Current price in 52-week range" />}
      </div>
    </div>
  );
}

export function ValueBars({ rows }: { rows: Array<{ label: string; value: number | null; color: string }> }) {
  const max = Math.max(1, ...rows.map((r) => (isNum(r.value) ? r.value : 0)));
  return (
    <div className="value-bars">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="value-bar-label">
            <span>{r.label}</span>
            <b className="mono">{money(r.value)}</b>
          </div>
          <div className="value-bar-track">
            <div style={{ width: isNum(r.value) ? `${Math.max(2, (r.value / max) * 100)}%` : 0, background: r.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** `source · as_of` tag on a data point (DESIGN.md §6). */
export function ProvenanceChip({ source, asOf }: { source: string; asOf: string | null }) {
  return (
    <span className="prov-chip mono" title="Data source and as-of date">
      {source}
      {asOf ? ` · ${asOf.slice(0, 10)}` : ""}
    </span>
  );
}

export function Tile({ label, value, color, hint }: { label: string; value: ReactNode; color?: string; hint?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value mono" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section navigation that follows the scroll position.

export function SectionNav({ sections }: { sections: Array<[string, string]> }) {
  const [active, setActive] = useState(sections[0]?.[0] ?? "");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-120px 0px -60% 0px" },
    );
    sections.forEach(([id]) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);
  return (
    <nav className="section-nav" aria-label="Page sections">
      {sections.map(([id, label]) => (
        <a key={id} href={`#${id}`} className={active === id ? "active" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Watchlist: browser-local for now; accounts exist (Auth0) but have no watchlist store yet.

const WATCHLIST_KEY = "dipbuyer:watchlist";
const WATCHLIST_EVENT = "dipbuyer:watchlist-changed";

function readWatchlist(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function useWatchlist() {
  const [symbols, setSymbols] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setSymbols(readWatchlist());
    sync();
    window.addEventListener(WATCHLIST_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WATCHLIST_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const toggle = useCallback((symbol: string) => {
    const current = readWatchlist();
    const next = current.includes(symbol) ? current.filter((s) => s !== symbol) : [...current, symbol];
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable (private mode): in-memory only
    }
    setSymbols(next);
    window.dispatchEvent(new Event(WATCHLIST_EVENT));
  }, []);
  return { symbols, has: (s: string) => symbols.includes(s), toggle };
}

export function WatchlistButton({ symbol }: { symbol: string }) {
  const { has, toggle } = useWatchlist();
  const on = has(symbol);
  return (
    <button type="button" className="action-tile" onClick={() => toggle(symbol)} aria-pressed={on}>
      <span>{on ? "On your watchlist" : "Add to watchlist"}</span>
      <span className="go" aria-hidden style={on ? { background: "var(--brand-gradient)" } : undefined}>
        {on ? "★" : "☆"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ticker search. The data providers behind the API have no name search, so this takes a
// ticker and validates its shape; the stock page reports unknown symbols.

export function TickerSearch({
  compact = false,
  hero = false,
  placeholder = "Ticker, e.g. NKE",
}: {
  compact?: boolean;
  hero?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    const s = value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) {
      setInvalid(true);
      return;
    }
    window.location.assign(`/stock/${encodeURIComponent(s)}`);
  }
  return (
    <form className={`ticker-search${compact ? " compact" : ""}${hero ? " search-xl" : ""}`} onSubmit={submit} role="search">
      <IconSearch className="search-icon" />
      <input
        aria-label="Research a stock by ticker"
        aria-invalid={invalid}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" className="btn">
        Research
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sortable screener table.

type SortKey = "convictionScore" | "quality" | "upside" | "drawdown" | "lynchRatio" | "peRatio" | "dividendYieldPct" | "return1Y" | "marketCapUsd";

const COLUMNS: Array<{ key: SortKey; label: string; render: (r: ScreenerRow) => ReactNode }> = [
  { key: "convictionScore", label: "Conviction", render: (r) => r.convictionScore },
  { key: "quality", label: "Quality", render: (r) => <span style={{ color: scoreColor(r.quality) }}>{score10(r.quality)}</span> },
  {
    key: "upside",
    label: "Intrinsic value",
    render: (r) => (
      <span className="stack">
        <span>{money(r.intrinsicValue)}</span>
        {isNum(r.upside) && (
          <small style={{ color: signColor(r.upside) }}>
            {frac(Math.abs(r.upside))} {r.upside >= 0 ? "below" : "above"}
          </small>
        )}
      </span>
    ),
  },
  { key: "drawdown", label: "Off 52w high", render: (r) => frac(isNum(r.drawdown) ? -r.drawdown : null) },
  { key: "lynchRatio", label: "Lynch ratio", render: (r) => ratio(r.lynchRatio) },
  { key: "peRatio", label: "P/E", render: (r) => ratio(r.peRatio, 1) },
  { key: "dividendYieldPct", label: "Yield", render: (r) => pct(r.dividendYieldPct) },
  { key: "return1Y", label: "1Y", render: (r) => <span style={{ color: signColor(r.return1Y) }}>{frac(r.return1Y, true)}</span> },
  { key: "marketCapUsd", label: "Mkt cap", render: (r) => bigMoney(r.marketCapUsd) },
];

export function ScreenerTable({ rows }: { rows: ScreenerRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey | null; dir: 1 | -1 }>({ key: null, dir: -1 });
  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const k = sort.key;
    return [...rows].sort((a, b) => {
      const av = a[k];
      const bv = b[k];
      if (!isNum(av) && !isNum(bv)) return 0;
      if (!isNum(av)) return 1;
      if (!isNum(bv)) return -1;
      return (av - bv) * sort.dir;
    });
  }, [rows, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th className="sticky-col">Company</th>
            <th>Verdict</th>
            {COLUMNS.map((c) => (
              <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir === -1 ? "descending" : "ascending") : "none"}>
                <button type="button" onClick={() => toggle(c.key)}>
                  {c.label}
                  {sort.key === c.key ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol}>
              <td className="sticky-col">
                <div className="company-cell">
                  <span className={`ticker-logo ${hueFor(r.symbol)}`} aria-hidden>
                    {r.symbol.slice(0, 4)}
                  </span>
                  <div>
                    <a href={`/stock/${r.symbol}`} className="symbol">
                      {r.symbol}
                    </a>
                    <div className="muted small">{r.lynchCategory?.replace(/_/g, " ") ?? DASH}</div>
                  </div>
                </div>
              </td>
              <td>
                <VerdictBadge verdict={r.verdict} />
              </td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="mono num">
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function toCsv(rows: ScreenerRow[]): string {
  const cols: Array<keyof ScreenerRow> = [
    "symbol", "verdict", "convictionScore", "lynchCategory", "price", "drawdown", "return1Y", "intrinsicValue", "upside",
    "lynchRatio", "peRatio", "epsGrowthPct", "dividendYieldPct", "roePct", "debtToEquity", "marketCapUsd", "quality", "health", "sources",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
