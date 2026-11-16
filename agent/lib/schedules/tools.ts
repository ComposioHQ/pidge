import { z } from "zod";
import type { ScheduledJob, ScheduleOrigin } from "../../../db/services/schedules";
import { type Cadence, formatLocal } from "../../../shared/schedules/recurrence";
import { type PidgePrincipal, readPrincipal } from "../identity/principal";

type Auth = Parameters<typeof readPrincipal>[0];

export const cadenceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("once"),
      at: z
        .string()
        .datetime({ offset: true })
        .describe("ISO 8601 time with the user's UTC offset, e.g. 2026-11-06T15:00:00-08:00."),
    }),
    z.object({
      kind: z.literal("interval"),
      every_minutes: z.number().int().describe("Elapsed minutes between runs (at least 15)."),
      first_at: z.string().datetime({ offset: true }).optional().describe("First run; defaults to now."),
    }),
    z.object({
      kind: z.literal("recurring"),
      cron: z
        .string()
        .max(100)
        .describe("5-field cron in the user's timezone, e.g. '0 8 * * 1-5' for weekdays at 8:00 AM local time."),
    }),
  ])
  .describe("When to run: once at a time, every N minutes, or a recurring local-time cron.");

export function toCadence(input: z.infer<typeof cadenceSchema>): Cadence {
  if (input.kind === "once") return { kind: "once", at: new Date(input.at) };
  if (input.kind === "interval") {
    return {
      kind: "interval",
      everyMinutes: input.every_minutes,
      firstAt: input.first_at ? new Date(input.first_at) : new Date(),
    };
  }
  return { kind: "recurring", cron: input.cron };
}

/**
 * Who may manage schedules in this turn. Scheduled report turns never administer schedules (spec §10.3); anyone
 * else must be an authenticated Pidge user.
 */
export function scheduleManager(auth: Auth): { ok: true; principal: PidgePrincipal } | { ok: false; error: string } {
  const principal = readPrincipal(auth);
  if (!principal) return { ok: false, error: "Not signed in." };
  if (principal.channel === "imessage" && principal.scheduledRunId) {
    return { ok: false, error: "Scheduled reports can't create or change schedules." };
  }
  return { ok: true, principal };
}

/**
 * The delivery destination for a new schedule: the current iMessage conversation. Web chat has no proactive
 * delivery path in this version (docs/decisions.md D12).
 */
export function scheduleOrigin(
  auth: Auth,
  eveSessionId: string,
): { ok: true; origin: ScheduleOrigin } | { ok: false; error: string } {
  const manager = scheduleManager(auth);
  if (!manager.ok) return manager;
  const { principal } = manager;
  if (principal.channel !== "imessage") {
    return {
      ok: false,
      error: "Schedules deliver over iMessage. Ask Pidge from your iMessage conversation to set this up.",
    };
  }
  return {
    ok: true,
    origin: { userId: principal.userId, eveSessionId, conversation: principal.conversation, handle: principal.handle },
  };
}

/** Model-facing view of a schedule: no delivery identifiers. */
export function describeSchedule(job: ScheduledJob) {
  const cadence =
    job.kind === "once"
      ? "one time"
      : job.kind === "interval"
        ? `every ${job.everyMinutes} minutes`
        : `cron "${job.cron}" (${job.timezone})`;
  return {
    id: job.id,
    title: job.title,
    instruction: job.instruction,
    cadence,
    timezone: job.timezone,
    enabled: job.enabled,
    next_run: job.nextRunAt ? formatLocal(job.nextRunAt, job.timezone) : null,
    last_run: job.lastRunAt ? formatLocal(job.lastRunAt, job.timezone) : null,
  };
}
