// Referrer-spam query strings.
//
// Since 2026-08 Google has been crawling URLs like
//
//   /?o=5798271622004&channel=884533&from=shared.php?id%3D716220-1322%26name=…
//   /?o=94591103340802&channel=8f07ac&from=jp.php?id%3D1033408-13013%26name=…
//
// They come from a link-spam campaign, not from anything on this site. Served
// as-is each one is a 200 clone of the clean page carrying a correct canonical,
// which Search Console files under "Alternative page with proper canonical
// tag". That is not an error, but it is a state that never changes, so every
// "Validate fix" on that reason fails forever. A 301 to the clean URL moves the
// URL into "Page with redirect" instead and the bucket can empty.
//
// Ported from IoMarkets.tv PR #24, which proved this shape works.
//
// Deliberately a signature match, not an allowlist. An allowlist would have to
// enumerate every analytics parameter (utm_*, gclid, fbclid, …) that nothing
// server-side reads but client-side tooling does; a wrong guess there breaks
// attribution silently. It also leaves real query strings alone — notably
// /opportunities and /tools/fair-value, which both filter from their own
// parameters.

const PHP_REFERRER = /\.php\b/i;

export function isSpamQuery(params: URLSearchParams): boolean {
  if (params.has("o") && params.has("channel")) return true;
  const from = params.get("from");
  return from !== null && PHP_REFERRER.test(from);
}
