/**
 * The weekly digest: what changed for one investor this week. Pure — the service gathers the inputs.
 * Plain HTML with inline styles (email clients ignore stylesheets) plus a text part.
 */

export interface DigestInput {
  name: string | null;
  weekEnding: string;
  appUrl: string;
  portfolio: { equity: number; cash: number; positions: number; unrealized: number } | null;
  agent: { runs: number; ordersPlaced: number; lastRunAt: string | null } | null;
  alerts: Array<{ symbol: string; kind: string; message: string; at: string }>;
  buys: Array<{ symbol: string; convictionScore: number; upside: number | null; drawdown: number | null }>;
  insiders: Array<{ ticker: string; company: string; totalUsd: number; insiders: number; topExecutiveBought: boolean }>;
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
}

const usd = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString("en-US")}`);
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
/** SEC issuer names arrive in capitals ("COOPER COMPANIES, INC."); mixed-case names are left alone. */
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function composeDigest(d: DigestInput): Digest {
  const hello = d.name ? `Hi ${d.name.split(" ")[0]},` : "Hi,";
  const lines: string[] = [hello, "", `Your DipBuyer week to ${d.weekEnding}.`, ""];
  const sections: string[] = [];
  const h2 = (t: string) => `<h2 style="font:600 16px system-ui,sans-serif;margin:24px 0 8px;color:#0b1020">${esc(t)}</h2>`;
  const p = (t: string) => `<p style="font:14px/1.5 system-ui,sans-serif;margin:0 0 8px;color:#333">${t}</p>`;
  const li = (t: string) => `<li style="font:14px/1.5 system-ui,sans-serif;margin:0 0 6px;color:#333">${t}</li>`;
  const link = (path: string, t: string) => `<a href="${esc(d.appUrl + path)}" style="color:#4f46e5">${esc(t)}</a>`;

  if (d.portfolio) {
    const s = `Portfolio ${usd(d.portfolio.equity)} across ${d.portfolio.positions} positions, ${usd(d.portfolio.cash)} in cash, unrealised ${d.portfolio.unrealized >= 0 ? "+" : ""}${usd(d.portfolio.unrealized)}.`;
    lines.push("YOUR PORTFOLIO", s, "");
    sections.push(h2("Your portfolio") + p(`${esc(s)} ${link("/portfolio", "Open portfolio")}`));
  }
  if (d.agent) {
    const s = d.agent.runs
      ? `The agent ran ${d.agent.runs} time${d.agent.runs === 1 ? "" : "s"} and placed ${d.agent.ordersPlaced} order${d.agent.ordersPlaced === 1 ? "" : "s"}.`
      : "The agent did not run this week.";
    lines.push("THE AGENT", s, "");
    sections.push(h2("The agent") + p(`${esc(s)} ${link("/agent", "Review runs")}`));
  }
  if (d.alerts.length) {
    lines.push("YOUR WATCHLIST ALERTS", ...d.alerts.map((a) => `- ${a.message}`), "");
    sections.push(h2("Your watchlist alerts") + `<ul style="padding-left:18px;margin:0">${d.alerts.map((a) => li(esc(a.message))).join("")}</ul>` + p(link("/watchlist", "Open watchlist")));
  }
  if (d.buys.length) {
    const row = (b: DigestInput["buys"][number]) =>
      `${b.symbol}: Lynch buy, conviction ${b.convictionScore}/100, ${pct(b.drawdown)} below its 52-week high${
        b.upside === null ? "" : b.upside >= 0 ? `, ${pct(b.upside)} below intrinsic value` : `, ${pct(-b.upside)} above intrinsic value`
      }`;
    lines.push("BUY VERDICTS NOW", ...d.buys.map((b) => `- ${row(b)}`), "");
    sections.push(
      h2("Buy verdicts now") +
        `<ul style="padding-left:18px;margin:0">${d.buys.map((b) => li(`${link(`/stock/${b.symbol}`, b.symbol)}: ${esc(row(b).slice(b.symbol.length + 2))}`)).join("")}</ul>`,
    );
  }
  if (d.insiders.length) {
    const row = (c: DigestInput["insiders"][number]) =>
      `${c.ticker} (${titleCase(c.company)}): ${usd(c.totalUsd)} by ${c.insiders} insider${c.insiders === 1 ? "" : "s"}${c.topExecutiveBought ? ", including a top executive" : ""}`;
    lines.push("INSIDERS BUYING THIS WEEK", ...d.insiders.map((c) => `- ${row(c)}`), "");
    sections.push(h2("Insiders buying this week") + `<ul style="padding-left:18px;margin:0">${d.insiders.map((c) => li(esc(row(c)))).join("")}</ul>` + p(link("/insiders", "All insider buying")));
  }
  if (!sections.length) {
    lines.push("A quiet week: nothing new on your watchlist, no new buy verdicts and no notable insider buying.", "");
    sections.push(p("A quiet week: nothing new on your watchlist, no new buy verdicts and no notable insider buying."));
  }

  const footer =
    "Research and education, not a personal recommendation. Capital at risk: the value of investments can fall as well as rise. " +
    "You get this because you subscribed to the weekly digest; turn it off any time on your digest page.";
  lines.push("--", footer, `${d.appUrl}/digest`);
  const html =
    `<div style="max-width:560px;margin:0 auto;padding:24px">` +
    p(esc(hello)) +
    p(`Your DipBuyer week to <b>${esc(d.weekEnding)}</b>.`) +
    sections.join("") +
    `<hr style="border:none;border-top:1px solid #e3e6ee;margin:24px 0">` +
    `<p style="font:12px/1.5 system-ui,sans-serif;color:#777;margin:0">${esc(footer)} ${link("/digest", "Manage the digest")}</p>` +
    `</div>`;
  const headline = d.alerts.length ? `${d.alerts.length} watchlist alert${d.alerts.length === 1 ? "" : "s"}` : d.buys.length ? `${d.buys.length} buy verdicts` : "your week";
  return { subject: `DipBuyer weekly: ${headline} (week to ${d.weekEnding})`, text: lines.join("\n"), html };
}
