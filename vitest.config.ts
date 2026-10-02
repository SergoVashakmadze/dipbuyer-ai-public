import { configDefaults, defineConfig } from "vitest/config";

/**
 * Root Vitest config (discovered by every package's `vitest run`). The custom resolve condition
 * makes tests resolve @dipbuyer/* workspace packages to their TS source, so tests need no build
 * step while Node runtime still resolves the same packages to built dist via package exports.
 * Vitest 4 no longer excludes dist/ by default; without it the compiled copies of every test run too.
 */
export default defineConfig({
  resolve: {
    conditions: ["@dipbuyer/source"],
  },
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
