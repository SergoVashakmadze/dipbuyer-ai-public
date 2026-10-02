import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { nextRunAt, parseCadence, parseTimeUtc } from "@dipbuyer/agent";
import { insiderDataPath } from "./insiders.js";

/** The builder ships in the image next to the compiled API (apps/api/scripts). */
const SCRIPT = fileURLToPath(new URL("../../scripts/build-insider-recent.mjs", import.meta.url));
const STALE_MS = 26 * 3_600_000;

/**
 * Keeps the insider data fresh without an external cron: INSIDER_REFRESH=daily runs the SEC Form 4
 * builder every day at INSIDER_REFRESH_TIME_UTC (default 06:00, after EDGAR publishes the previous
 * day's index), and once at startup when the file is missing or older than a day. The builder caches
 * filings next to its output, so a daily run only fetches the new day. One run at a time.
 */
@Injectable()
export class InsiderRefresher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("insiders");
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<{ ok: boolean; output: string }> | null = null;
  lastRun: { at: string; ok: boolean; summary: string } | null = null;

  onModuleInit() {
    const cadence = parseCadence(process.env.INSIDER_REFRESH);
    if (cadence === "off") return;
    if (this.isStale()) void this.refresh();
    const arm = () => {
      const at = nextRunAt(cadence, parseTimeUtc(process.env.INSIDER_REFRESH_TIME_UTC ?? "06:00"), new Date());
      if (!at) return;
      this.timer = setTimeout(async () => {
        if (Date.now() >= at.getTime() - 1_000) await this.refresh();
        arm();
      }, Math.max(1_000, Math.min(at.getTime() - Date.now(), 24 * 3_600_000)));
    };
    arm();
  }
  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  isStale(): boolean {
    try {
      return Date.now() - statSync(insiderDataPath()).mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  }

  /** Run the builder now (or join the run in progress). Resolves when it finishes. */
  refresh(days = Number(process.env.INSIDER_REFRESH_DAYS ?? 120)): Promise<{ ok: boolean; output: string }> {
    if (this.running) return this.running;
    this.running = new Promise<{ ok: boolean; output: string }>((resolve) => {
      let output = "";
      const child = spawn(process.execPath, [SCRIPT, "--days", String(days), "--out", insiderDataPath()], { env: process.env });
      const keep = (b: Buffer) => (output = (output + b.toString()).slice(-4_000));
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (e) => resolve({ ok: false, output: e.message }));
      child.on("close", (code) => resolve({ ok: code === 0, output }));
    }).then((r) => {
      // On failure the useful line is the error, not Node's trailing version banner.
      const lines = r.output.replace(/\r/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
      const summary = (r.ok ? lines.at(-1) : lines.find((l) => /Error|error:|ENOENT|EACCES|not set/.test(l)) ?? lines.at(-1))?.slice(-300) ?? "";
      this.lastRun = { at: new Date().toISOString(), ok: r.ok, summary };
      if (r.ok) this.log.log(`refreshed: ${summary}`);
      else this.log.error(`refresh failed: ${summary}`);
      this.running = null;
      return r;
    });
    return this.running;
  }

  get inProgress(): boolean {
    return this.running !== null;
  }
}
