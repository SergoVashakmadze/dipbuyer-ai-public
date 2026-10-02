/**
 * When the scheduled agent runs next. Pure, so the cadence rules are unit-tested rather than
 * discovered in production. Times are UTC; weekends are skipped (US markets closed).
 *
 * daily   — every weekday at the configured time
 * weekly  — Mondays
 * monthly — the first weekday of each month (the backtest rebalances monthly)
 */
export type ScheduleCadence = "off" | "daily" | "weekly" | "monthly";

export function parseCadence(v: string | undefined): ScheduleCadence {
  const s = (v ?? "").trim().toLowerCase();
  return s === "daily" || s === "weekly" || s === "monthly" ? s : "off";
}

/** "HH:MM" in UTC; invalid input falls back to 21:30 (after the US close). */
export function parseTimeUtc(v: string | undefined): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((v ?? "").trim());
  if (match) {
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 24 && m < 60) return { h, m };
  }
  return { h: 21, m: 30 };
}

const isWeekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

export function nextRunAt(cadence: ScheduleCadence, time: { h: number; m: number }, now: Date): Date | null {
  if (cadence === "off") return null;
  const at = (y: number, mo: number, day: number) => new Date(Date.UTC(y, mo, day, time.h, time.m, 0, 0));
  if (cadence === "monthly") {
    for (let k = 0; k < 3; k++) {
      const y = now.getUTCFullYear();
      const mo = now.getUTCMonth() + k;
      let d = at(y, mo, 1);
      while (!isWeekday(d)) d = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      if (d > now) return d;
    }
    return null;
  }
  let d = at(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 0; i < 14; i++) {
    const ok = cadence === "daily" ? isWeekday(d) : d.getUTCDay() === 1;
    if (ok && d > now) return d;
    d = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  return null;
}
