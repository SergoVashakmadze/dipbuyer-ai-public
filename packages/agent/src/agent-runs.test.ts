import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAgentRunStore, InMemoryAgentRunStore, type AgentRun } from "./runs.js";
import { nextRunAt, parseCadence, parseTimeUtc } from "./schedule.js";

const run = (id: string): AgentRun => ({
  id, trigger: "manual", startedAt: "2026-09-17T10:00:00Z", finishedAt: null, mode: "ADVISORY", execution: "PAPER", status: "planned",
  universe: ["AAA"], unavailable: [], decisions: [], sizing: null, proposals: [],
});

describe("agent run stores", () => {
  it("keeps newest first, updates in place, and returns copies", async () => {
    const s = new InMemoryAgentRunStore();
    await s.save(run("a"));
    await s.save(run("b"));
    await s.save({ ...run("a"), status: "executed" });
    const recent = await s.recent();
    expect(recent.map((r) => r.id)).toEqual(["b", "a"]);
    expect(recent[1]!.status).toBe("executed");
    recent[0]!.status = "failed";
    expect((await s.get("b"))!.status).toBe("planned");
  });

  it("survives a restart when backed by a file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "runs-")), "nested", "runs.json");
    await new FileAgentRunStore(path).save(run("x"));
    expect(JSON.parse(readFileSync(path, "utf8"))[0].id).toBe("x");
    expect((await new FileAgentRunStore(path).get("x"))!.id).toBe("x");
  });
});

describe("agent schedule", () => {
  const t = { h: 21, m: 30 };
  it("is off unless a known cadence is set", () => {
    expect(parseCadence(undefined)).toBe("off");
    expect(parseCadence("Monthly")).toBe("monthly");
    expect(nextRunAt("off", t, new Date())).toBeNull();
    expect(parseTimeUtc("25:00")).toEqual({ h: 21, m: 30 });
  });
  it("daily skips weekends", () => {
    // Friday 2026-09-18 22:00 UTC -> Monday 21 Sept 21:30
    expect(nextRunAt("daily", t, new Date("2026-09-18T22:00:00Z"))!.toISOString()).toBe("2026-09-21T21:30:00.000Z");
    expect(nextRunAt("daily", t, new Date("2026-09-17T10:00:00Z"))!.toISOString()).toBe("2026-09-17T21:30:00.000Z");
  });
  it("weekly runs on Mondays", () => {
    expect(nextRunAt("weekly", t, new Date("2026-09-17T10:00:00Z"))!.toISOString()).toBe("2026-09-21T21:30:00.000Z");
  });
  it("monthly runs on the first weekday of the month", () => {
    // 1 Nov 2026 is a Sunday -> Monday 2 Nov
    expect(nextRunAt("monthly", t, new Date("2026-10-02T00:00:00Z"))!.toISOString()).toBe("2026-11-02T21:30:00.000Z");
    expect(nextRunAt("monthly", t, new Date("2026-09-17T00:00:00Z"))!.toISOString()).toBe("2026-10-01T21:30:00.000Z");
  });
});
