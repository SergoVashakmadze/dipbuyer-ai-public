import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Defaults: no incremental cache store. Pages that revalidate (e.g. /news every 5 minutes) are
// re-rendered on demand, which is fine at this traffic and keeps everything on the free plan.
export default defineCloudflareConfig();
