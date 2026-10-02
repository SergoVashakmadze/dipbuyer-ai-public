# DipBuyer AI — Design System (`DESIGN.md`)

> Per-project design system. Overrides the global `~/.claude/DESIGN.md`. Follows the awesome-design-md 9-section standard. **Principle: transparency *is* the UX** — the product must feel calm, premium and trustworthy enough to show a regulator and an investor on the same screen. All tokens are white-label-overridable (see §9).

---

## 1. Brand & Personality
- **Personality:** disciplined, transparent, premium, calm. The opposite of hype-driven trading apps. Think "research terminal meets open-source audit trail."
- **Voice:** clear, numbers-backed, jargon-light. Lead with the verdict, then the one-sentence reason, then the evidence. Criterion ids never reach the screen raw: every one has a plain-English label and help line (`components/decision-ui.tsx`).
- **Mood:** light and airy by default with colourful accents, plus a full dark mode (ValueSense-inspired, 2026-09-17 rework). Confident, not clinical.

## 2. Color
Light-first. Tokens are CSS variables in `apps/web/app/globals.css` so partners can re-theme.

| Token | Hex (default) | Use |
|---|---|---|
| `--bg` | `#F4F5F9` | App canvas (cool off-white) |
| `--bg-elevated` | `#FFFFFF` | Cards, header, tables |
| `--bg-subtle` | `#F0F2F7` | Tiles, inputs, hover surfaces |
| `--border` / `--border-strong` | `#E3E6EE` / `#CFD4E0` | Dividers, card borders / inputs |
| `--text` / `--text-muted` / `--text-faint` | `#0B1020` / `#5B6378` / `#8A91A5` | Text hierarchy |
| `--ink` | `#0B1020` | Primary buttons, active pills and tabs |
| `--brand` / `--brand-2` | `#4F46E5` / `#7C3AED` | Links, focus, brand mark; `--brand-gradient` for icons and the hero |
| `--success` + `-soft` (buy) | `#15803D` / `#DCFCE7` | Buy, pass, positive P&L |
| `--warning` + `-soft` (hold) | `#B45309` / `#FEF3C7` | Hold, caution |
| `--danger` + `-soft` (sell/avoid) | `#DC2626` / `#FEE2E2` | Sell, avoid, fail, negative P&L |
| `--neutral` + `-soft` (abstain) | `#64748B` / `#EEF1F5` | No verdict, n/a |

**Accent hues** (`.hue-violet|sky|emerald|amber|rose` set `--hue-grad`, `--hue-soft`, `--hue-ink`): feature and nav icons, idea-list tags and cards, step numbers, methodology categories, and a stable per-ticker company logo colour (`hueFor(symbol)`). The canvas carries soft fixed colour glows (`--canvas-glow`); research headers and stat bands get a thin `--rainbow` strip. Colour decorates; it never carries meaning on its own.

**Dark mode:** `:root[data-theme="dark"]` redefines every token (surfaces `#0A0B16`/`#12142A`, text `#EEF0FF`, brand `#8B93FF`, verdict hues lifted for contrast). `components/theme.tsx` sets `data-theme` in `<head>` before first paint from the saved choice (`localStorage` key `dipbuyer:theme`) or the system setting, follows system changes until the user chooses, and the header toggle switches it. TradingView embeds rebuild with the matching theme.

**Semantic verdict colors are fixed across themes** (buy=green, hold=amber, sell/avoid=red, abstain=grey), rendered as soft tinted pills with a dot and a label — never colour alone. WCAG 2.2 AA contrast.

## 3. Typography
- **Sans (UI):** Inter via `next/font` (`--font-inter`). Headings 650-750 weight with tight negative tracking.
- **Mono (numbers):** JetBrains Mono (`--font-mono-face`) with `tabular-nums` for prices, ratios and P&L.
- **Scale:** body 15px; h1 2.25rem (home hero up to 4.2rem); h2 1.45rem (section heads 2.1rem); line-height 1.55 body, ~1.15 headings.
- **Numbers:** always formatted (`$98.8B`, `1.34x`, `7.4%`), never raw floats; sign explicit; P&L coloured by sign.

## 4. Spacing & Layout
- 4px base grid; spacing scale 1/2/3/4/6/8/12/16/24 (×4px).
- Max content width 1240px; sticky glass header 64px; grouped navigation (Research / Strategy / Portfolio / Trust) with dropdowns.
- Generous whitespace; cards `--bg-elevated`, radius `20px`, 1px `--border`, soft shadow; tiles radius `14px`; buttons and pills fully rounded.
- Breakpoints: sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536. Full functionality to mobile.

## 5. Elevation & Depth
- Soft layered shadows (`--shadow-sm`, `--shadow`, `--shadow-lg` for menus); cards lift 2px on hover.
- Radius: cards 20px, tiles/inputs 12-14px, buttons/pills/badges full.
- Focus ring: 2px `--accent` offset (keyboard-visible, AA).

## 6. Core Components
- **Verdict badge:** pill colored by verdict (buy/hold/trim/sell/abstain) with icon + label.
- **Conviction gauge:** 0–100 radial/linear gauge; animated reveal (Framer Motion); color-graded.
- **Criteria checklist:** table of `criterion · value · threshold · pass/fail/NA`, the explainability surface — present on every decision.
- **Decision card:** verdict → one-line thesis → "Why?" expander (category, checklist, gauge, sources, sell triggers).
- **Price chart:** TradingView `lightweight-charts` + widgets.
- **Equity/drawdown chart:** backtest results (Recharts/lightweight-charts).
- **Data grid:** AG Grid (Community) for screener results & trade blotter; sortable, tabular-nums.
- **Provenance chip:** small `source · as_of` tag on data points (builds trust + audit).
- **On-chain badge:** "Verified on Algorand" with txid link → `apps/verifier`.
- **Disclaimer banner:** persistent capital-at-risk; advised-vs-non-advised label.
- Buttons (primary gold / secondary outline / ghost / danger), inputs, selects, dialogs, toasts, tabs, skeletons, empty/error states — from shadcn/ui wrapped with tokens.

## 7. Motion
- Framer Motion; 150–250ms ease-out for UI, spring for gauges/score reveals. 60fps; respect `prefers-reduced-motion`.
- Microinteractions: animated score reveal, smooth chart crosshair, optimistic-but-reconciled order states. Tasteful, never gratuitous.

## 8. Accessibility (WCAG 2.2 AA — also a Consumer Duty requirement)
- Full keyboard nav; visible focus; semantic roles/labels; AA contrast.
- Comprehension-tested copy; no color-only signalling (verdict has icon + label).
- High-impact actions get confirmation friction; exit is frictionless (no "sludge").

## 9. White-Label Theming
- All visual tokens (color, type family, radius, logo, app name) are runtime-overridable per `Tenant` — no code changes.
- Ship a default DipBuyer brand + a partner theming guide; verdict semantics and accessibility minimums are **non-overridable**.
- Logo slots: app header, login, report header, embeddable widgets.

---

### Key screens (information architecture)
Dashboard · Opportunities (screener) · Portfolio · Decision detail · Backtest studio · Reports/Audit · Settings/Suitability. Every screen ≤3 clicks; every recommendation/holding exposes its "Why?".
