"use client";

import { useEffect, useState } from "react";
import { useAuthedFetch } from "./use-authed-fetch";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

/** "Watch" toggle on a stock page. Adds with the default alerts (turns buy, 15% dip, insider buying). */
export function WatchButton({ symbol }: { symbol: string }) {
  const authedFetch = useAuthedFetch();
  const [watching, setWatching] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authedFetch(`${BASE}/watchlist/symbols`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { symbols?: string[] } | null) => setWatching(b?.symbols ? b.symbols.includes(symbol) : null))
      .catch(() => setWatching(null));
  }, [authedFetch, symbol]);

  if (watching === null) return null; // signed out or API without watchlists
  async function toggle() {
    setBusy(true);
    try {
      const r = await authedFetch(`${BASE}/watchlist/${symbol}`, {
        method: watching ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: watching ? undefined : "{}",
      });
      if (r.ok) setWatching(!watching);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className={`btn btn-sm ${watching ? "btn-outline" : ""}`} onClick={toggle} disabled={busy} title="Alerts when it turns buy, dips 15%, or insiders buy">
      {watching ? "★ Watching" : "☆ Watch"}
    </button>
  );
}

/** Header link to the watchlist, with the unread alert count. Cheap: never triggers a re-check. */
export function WatchlistBell() {
  const authedFetch = useAuthedFetch();
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const load = () =>
      authedFetch(`${BASE}/watchlist/symbols`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { unread?: number } | null) => setUnread(b?.unread ?? null))
        .catch(() => setUnread(null));
    void load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, [authedFetch]);
  if (unread === null) return null;
  return (
    <a className="status-chip todo" href="/watchlist" title={unread ? `${unread} new alert${unread === 1 ? "" : "s"}` : "Watchlist"}>
      ★ Watchlist{unread > 0 && <b style={{ marginLeft: 6 }}>{unread}</b>}
    </a>
  );
}

/** Header link to /admin, shown only to an admin (ADMIN_SUBJECTS on the API). */
export function AdminLink() {
  const authedFetch = useAuthedFetch();
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    authedFetch(`${BASE}/admin/whoami`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { admin?: boolean } | null) => setAdmin(!!b?.admin))
      .catch(() => setAdmin(false));
  }, [authedFetch]);
  return admin ? (
    <a className="status-chip ok" href="/admin" title="Operator console">
      Admin
    </a>
  ) : null;
}
