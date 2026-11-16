import { Cron } from "croner";

/** Shortest gap Pidge allows between two runs of one schedule. */
export const MIN_GAP_MINUTES = 15;
/** Furthest ahead a one-time schedule may be set. */
export const MAX_LEAD_DAYS = 366;

export type Cadence =
  | { kind: "once"; at: Date }
  | { kind: "interval"; everyMinutes: number; firstAt: Date }
  | { kind: "recurring"; cron: string };

export type CadenceError = { error: string };

function cronIn(cron: string, timezone: string): Cron | CadenceError {
  const invalid = {
    error: `"${cron}" is not a valid 5-field cron expression (minute hour day-of-month month day-of-week).`,
  };
  if (cron.trim().split(/\s+/).length !== 5) return invalid;
  try {
    return new Cron(cron, { timezone, paused: true });
  } catch {
    return invalid;
  }
}

/**
 * Validates a cadence and returns its first occurrence. Recurring cron expressions are evaluated in `timezone`,
 * so "0 9 * * 1-5" stays at 09:00 local time across DST changes (spec §13.1). Every cadence is bounded: no runs
 * closer together than MIN_GAP_MINUTES and no one-time run more than MAX_LEAD_DAYS ahead.
 */
export function firstOccurrence(cadence: Cadence, timezone: string, now: Date): Date | CadenceError {
  switch (cadence.kind) {
    case "once": {
      if (Number.isNaN(cadence.at.getTime())) return { error: "The time is not a valid date." };
      if (cadence.at.getTime() < now.getTime() - 60_000) return { error: "That time has already passed." };
      if (cadence.at.getTime() > now.getTime() + MAX_LEAD_DAYS * 86_400_000) {
        return { error: `One-time schedules can be at most ${MAX_LEAD_DAYS} days ahead.` };
      }
      return cadence.at;
    }
    case "interval": {
      if (!Number.isInteger(cadence.everyMinutes) || cadence.everyMinutes < MIN_GAP_MINUTES) {
        return { error: `Intervals must be whole minutes, at least ${MIN_GAP_MINUTES}.` };
      }
      if (Number.isNaN(cadence.firstAt.getTime())) return { error: "The first run time is not a valid date." };
      return cadence.firstAt.getTime() < now.getTime() ? now : cadence.firstAt;
    }
    case "recurring": {
      const cron = cronIn(cadence.cron, timezone);
      if ("error" in cron) return cron;
      const runs = cron.nextRuns(6, now);
      const [first] = runs;
      if (!first) return { error: "That cron expression never fires." };
      for (let i = 1; i < runs.length; i++) {
        const gap = (runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime();
        if (gap < MIN_GAP_MINUTES * 60_000) {
          return { error: `Recurring schedules can run at most every ${MIN_GAP_MINUTES} minutes.` };
        }
      }
      return first;
    }
  }
}

/**
 * The occurrence after one that has just been claimed, strictly later than `now`. Occurrences missed while Pidge
 * was down are coalesced into the one being claimed rather than replayed one by one. One-time schedules have none.
 */
export function nextOccurrence(
  job: { kind: "once" | "interval" | "recurring"; cron: string | null; everyMinutes: number | null; timezone: string },
  claimed: Date,
  now: Date,
): Date | null {
  if (job.kind === "once") return null;
  if (job.kind === "interval") {
    const step = (job.everyMinutes ?? 0) * 60_000;
    if (step <= 0) return null;
    const behind = Math.max(0, now.getTime() - claimed.getTime());
    return new Date(claimed.getTime() + (Math.floor(behind / step) + 1) * step);
  }
  if (!job.cron) return null;
  const cron = cronIn(job.cron, job.timezone);
  if ("error" in cron) return null;
  return cron.nextRun(new Date(Math.max(now.getTime(), claimed.getTime()))) ?? null;
}

/** "Thu, Nov 5, 3:00 PM PST" in the schedule's timezone, for lists and replies. */
export function formatLocal(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
