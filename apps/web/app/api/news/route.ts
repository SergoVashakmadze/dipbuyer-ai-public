import { NextResponse } from "next/server";
import { getNews } from "../../../lib/news/aggregate";
import type { NewsCategory } from "../../../lib/news/feeds";

/**
 * Stateless: aggregates on request, caches at the edge, stores nothing. No database to keep in
 * sync and no scheduled job burning CI minutes when nobody is reading.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = (searchParams.get("category") ?? "all") as NewsCategory | "all";
  const limit = Math.min(Number(searchParams.get("limit")) || 60, 120);

  const result = await getNews(category, limit);

  return NextResponse.json(result, {
    headers: {
      // Serve the cached copy instantly and refresh behind the reader's back.
      "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
    },
  });
}
