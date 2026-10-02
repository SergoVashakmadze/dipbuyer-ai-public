/**
 * Resilient fetch helpers for the data adapters. financialdatasets.ai and Alpaca are rate-limited
 * (429 + Retry-After) and a backtest sweep re-requests identical GETs, so both a retry wrapper and
 * a short-lived cache pay off. Each wrapper is fetch-compatible (returns `typeof fetch`) so they
 * compose:
 *
 *   const f = withCache(withRetry(fetch), { ttlMs: 60_000 });
 *
 * For a shared cache across processes/instances, pass a Redis-backed `FetchCache` instead of the
 * default `MemoryFetchCache` — the contract is intentionally tiny (get/set of a string body).
 */

export interface RetryOptions {
  /** Max retries after the first attempt (default 3). */
  retries?: number;
  /** Backoff base for exponential delay when no Retry-After header is present (default 500ms). */
  baseDelayMs?: number;
  /** Injectable sleep (tests pass a no-op to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra statuses to retry besides 429/5xx. SEC answers bursts with 403, not 429. */
  alsoRetry?: number[];
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds; null if unparseable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - nowMs);
}

/**
 * Retry 429 and 5xx responses, honouring Retry-After then exponential backoff, and network-level
 * failures (undici's `TypeError: fetch failed` on a reset connection or DNS blip). Those throw
 * before any status exists, so they used to escape the retry loop entirely: one blip dropped a
 * symbol from a backtest clock (WMT Jan-Mar 2016 in the 2026-09-17 signals run, CAGR 13.46 -> 13.06).
 * An abort is the caller's decision and is never retried.
 */
export function withRetry(fetchImpl: typeof fetch, opts: RetryOptions = {}): typeof fetch {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(input, init);
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || attempt >= retries) throw e;
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      const retriable = res.status === 429 || res.status >= 500 || (opts.alsoRetry?.includes(res.status) ?? false);
      if (!retriable || attempt >= retries) return res;
      const wait = parseRetryAfter(res.headers?.get?.("retry-after")) ?? baseDelayMs * 2 ** attempt;
      await sleep(wait);
    }
  }) as typeof fetch;
}

/** Minimal cache contract — implement with Redis for a cross-instance cache. */
export interface FetchCache {
  get(key: string): { body: string; status: number } | undefined;
  set(key: string, value: { body: string; status: number }, ttlMs: number): void;
}

export interface CacheOptions {
  ttlMs?: number;
  cache?: FetchCache;
  /** Injectable clock (tests advance it to exercise TTL expiry). */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

/** In-process TTL cache. Swap for a Redis-backed FetchCache in multi-instance deployments. */
export class MemoryFetchCache implements FetchCache {
  private readonly store = new Map<string, { body: string; status: number; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  get(key: string): { body: string; status: number } | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return { body: hit.body, status: hit.status };
  }
  set(key: string, value: { body: string; status: number }, ttlMs: number): void {
    this.store.set(key, { ...value, expires: this.now() + ttlMs });
  }
}

/** Memoise successful GETs by URL for ttlMs. Only GET + ok responses are cached. */
export function withCache(fetchImpl: typeof fetch, opts: CacheOptions = {}): typeof fetch {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cache = opts.cache ?? new MemoryFetchCache(opts.now);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return fetchImpl(input, init);
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const hit = cache.get(url);
    if (hit) return new Response(hit.body, { status: hit.status });
    const res = await fetchImpl(input, init);
    if (res.ok) {
      const body = await res.clone().text();
      cache.set(url, { body, status: res.status }, ttlMs);
    }
    return res;
  }) as typeof fetch;
}
