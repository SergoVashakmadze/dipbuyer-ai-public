#!/usr/bin/env node
/**
 * CI guard: ensures config/strategy.lynch.json is valid JSON, declares the lower-is-better
 * PEG convention, and that PROMPT.md points at the config as the source of truth.
 * Extend this to assert any specific numbers PROMPT.md quotes match the config.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
const fail = (m) => {
  console.error("✗", m);
  failed = true;
};

let config;
try {
  config = JSON.parse(readFileSync(resolve(root, "config/strategy.lynch.json"), "utf8"));
} catch (e) {
  fail(`config/strategy.lynch.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (config?.conventions?.peg_convention !== "lower_is_better") {
  fail("PEG convention must be 'lower_is_better' (PROMPT.md and engine assume it).");
}
for (const cat of ["slow_grower", "stalwart", "fast_grower", "cyclical", "turnaround", "asset_play"]) {
  if (!config?.categories?.[cat]) fail(`Missing category config: ${cat}`);
}

const prompt = readFileSync(resolve(root, "PROMPT.md"), "utf8");
if (!prompt.includes("config/strategy.lynch.json")) {
  fail("PROMPT.md must reference config/strategy.lynch.json as the source of truth.");
}

if (failed) {
  console.error("\nConfig drift check FAILED.");
  process.exit(1);
}
console.log("✓ config drift check passed");
