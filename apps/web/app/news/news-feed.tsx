"use client";

import { useMemo, useState } from "react";
import type { Article } from "../../lib/news/aggregate";
import { NEWS_CATEGORIES, type NewsCategory } from "../../lib/news/feeds";

interface Props {
  initial: Article[];
  sourcesOk: number;
  sourcesTried: number;
  fetchedAt: string;
}

/** "14 min ago" reads better than a timestamp on a page whose whole point is recency. */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Publisher favicon, so a card without an image still carries its source visually. */
function faviconOf(url: string): string | null {
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(url).hostname}`;
  } catch {
    return null;
  }
}

export function NewsFeedView({ initial, sourcesOk, sourcesTried, fetchedAt }: Props) {
  const [category, setCategory] = useState<NewsCategory | "all">("all");
  const [query, setQuery] = useState("");
  // Publishers hotlink-protect thumbnails. A broken image is worse than none, and setting
  // style.display on the error event does not survive a re-render — so drop it from the tree.
  const [broken, setBroken] = useState<Record<string, true>>({});

  // Everything is already loaded, so filtering is local — no request per keystroke, and no
  // spinner between clicking a category and seeing it.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initial.filter((a) => {
      if (category !== "all" && a.category !== category) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.source.toLowerCase().includes(q) ||
        a.symbols.some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [initial, category, query]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of initial) m.set(a.category, (m.get(a.category) ?? 0) + 1);
    return m;
  }, [initial]);

  return (
    <>
      <div className="news-toolbar">
        <div className="chip-row news-cats">
          {NEWS_CATEGORIES.filter((c) => c.id === "all" || counts.get(c.id)).map((c) => (
            <button
              key={c.id}
              type="button"
              className={`btn btn-sm ${category === c.id ? "btn-brand" : "btn-outline"}`}
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
              <span className="news-count">{c.id === "all" ? initial.length : counts.get(c.id)}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="news-search"
          placeholder="Filter headlines or a ticker…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter headlines"
        />
      </div>

      <p className="news-meta">
        {shown.length} of {initial.length} stories · {sourcesOk} of {sourcesTried} sources responded
        · fetched {ago(fetchedAt)}
      </p>

      {shown.length === 0 ? (
        <div className="card news-empty">
          <p className="muted">
            Nothing matches <b>{query}</b> in {category === "all" ? "any category" : category}.
          </p>
        </div>
      ) : (
        <div className="news-grid">
          {shown.map((a) => (
            <article className="card news-card" key={a.id}>
              {a.imageUrl && !broken[a.id] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="news-thumb"
                  src={a.imageUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => setBroken((b) => ({ ...b, [a.id]: true }))}
                />
              )}
              <div className="news-body">
                <div className="news-source">
                  {faviconOf(a.url) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={faviconOf(a.url)!} alt="" width={16} height={16} loading="lazy" />
                  )}
                  <span>{a.source}</span>
                  <span className="news-dot">·</span>
                  <time dateTime={a.publishedAt}>{ago(a.publishedAt)}</time>
                  {a.sentiment !== "neutral" && (
                    <span className={`news-sent ${a.sentiment}`}>{a.sentiment}</span>
                  )}
                </div>
                <h3>
                  <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">
                    {a.title}
                  </a>
                </h3>
                {a.summary && <p className="news-summary">{a.summary}</p>}
                {a.symbols.length > 0 && (
                  <div className="news-symbols">
                    {a.symbols.map((s) => (
                      <a key={s} className="tag" href={`/stock/${s}`}>
                        {s}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
