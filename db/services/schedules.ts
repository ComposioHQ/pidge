import { and, count, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { type Cadence, firstOccurrence, nextOccurrence } from "../../shared/schedules/recurrence";
import type { Database } from "../client";
import { scheduledJobs, scheduledRuns } from "../schema";
import { getSettings } from "./settings";

/** Most enabled schedules one user may have. */
export const MAX_ACTIVE_SCHEDULES = 25;
/**
 * Bounded runtime of one scheduled run, from claim to the end of its report turn (spec §13.1). Longer than the
 * workflow engine's 860 s inline step lease, so a report turn interrupted by a restart can still finish once eve
 * re-runs the interrupted step (docs/mvp-verification.md, restart scenario).
 */
export const LEASE_MS = 20 * 60_000;
/** Claims of one occurrence before it is given up as failed (only while its report was never accepted). */
export const MAX_ATTEMPTS = 3;
const OUTCOME_MAX = 500;

export type ScheduleOrigin = { userId: string; eveSessionId: string; conversation: string; handle: string };
export type ScheduleInput = { title: string; instruction: string; cadence: Cadence };
export type ScheduledJob = typeof scheduledJobs.$inferSelect;

export type ClaimedRun = {
  runId: string;
  jobId: string;
  userId: string;
  eveSessionId: string;
  conversation: string;
  handle: string;
  title: string;
  instruction: string;
  scheduledFor: Date;
  attempts: number;
};

function cadenceColumns(cadence: Cadence) {
  return {
    kind: cadence.kind,
    cron: cadence.kind === "recurring" ? cadence.cron : null,
    everyMinutes: cadence.kind === "interval" ? cadence.everyMinutes : null,
  };
}

/**
 * Creates a schedule owned by the conversation's user and delivered to that conversation. The timezone comes from
 * the user's settings (never the model), and the cadence is validated and bounded before anything is stored.
 */
export async function createSchedule(
  db: Database,
  origin: ScheduleOrigin,
  input: ScheduleInput,
  now = new Date(),
): Promise<{ ok: true; job: ScheduledJob } | { ok: false; error: string }> {
  const settings = await getSettings(db, origin.userId);
  if (!settings) return { ok: false, error: "No settings found for this user." };
  const [active] = await db
    .select({ n: count() })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.userId, origin.userId), eq(scheduledJobs.enabled, true)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_SCHEDULES) {
    return { ok: false, error: `You already have ${MAX_ACTIVE_SCHEDULES} active schedules; cancel one first.` };
  }
  const first = firstOccurrence(input.cadence, settings.timezone, now);
  if ("error" in first) return { ok: false, error: first.error };
  const [job] = await db
    .insert(scheduledJobs)
    .values({
      userId: origin.userId,
      eveSessionId: origin.eveSessionId,
      externalConversationId: origin.conversation,
      deliveryHandle: origin.handle,
      title: input.title,
      instruction: input.instruction,
      ...cadenceColumns(input.cadence),
      timezone: settings.timezone,
      nextRunAt: first,
    })
    .returning();
  if (!job) throw new Error("schedule insert returned nothing");
  return { ok: true, job };
}

/** The user's schedules, newest first, each with its latest run; never another user's rows. */
export async function listSchedules(db: Database, userId: string) {
  const jobs = await db
    .select()
    .from(scheduledJobs)
    .where(eq(scheduledJobs.userId, userId))
    .orderBy(desc(scheduledJobs.createdAt));
  if (jobs.length === 0) return [];
  const runs = await db
    .select()
    .from(scheduledRuns)
    .where(
      and(
        eq(scheduledRuns.userId, userId),
        inArray(
          scheduledRuns.jobId,
          jobs.map((job) => job.id),
        ),
      ),
    )
    .orderBy(desc(scheduledRuns.scheduledFor));
  return jobs.map((job) => ({ ...job, runs: runs.filter((run) => run.jobId === job.id).slice(0, 10) }));
}

async function ownedJob(db: Database, userId: string, id: string) {
  const [job] = await db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId)))
    .limit(1);
  return job ?? null;
}

/**
 * Changes an owned schedule. A new cadence is validated like a new schedule; resuming recomputes the next
 * occurrence from now so a paused recurring schedule doesn't replay what it missed.
 */
export async function updateSchedule(
  db: Database,
  userId: string,
  id: string,
  patch: { title?: string; instruction?: string; cadence?: Cadence; enabled?: boolean },
  now = new Date(),
): Promise<{ ok: true; job: ScheduledJob } | { ok: false; error: string }> {
  const job = await ownedJob(db, userId, id);
  if (!job) return { ok: false, error: "No schedule with that ID." };
  const set: Partial<typeof scheduledJobs.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.instruction !== undefined) set.instruction = patch.instruction;
  if (patch.cadence) {
    const first = firstOccurrence(patch.cadence, job.timezone, now);
    if ("error" in first) return { ok: false, error: first.error };
    Object.assign(set, cadenceColumns(patch.cadence), { nextRunAt: first });
  }
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    // Resuming a one-time schedule keeps its time (a missed time fires on the next tick); recurring ones skip what
    // they missed while paused.
    if (patch.enabled && !job.enabled && !patch.cadence && job.kind !== "once") {
      set.nextRunAt =
        job.kind === "interval" && job.nextRunAt && job.nextRunAt > now ? job.nextRunAt : nextOccurrence(job, now, now);
    }
  }
  const [updated] = await db
    .update(scheduledJobs)
    .set(set)
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId)))
    .returning();
  return updated ? { ok: true, job: updated } : { ok: false, error: "No schedule with that ID." };
}

/** Deletes an owned schedule and its runs; an in-flight report stops at its next model call. */
export async function deleteSchedule(db: Database, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(scheduledJobs)
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId)))
    .returning({ id: scheduledJobs.id });
  return deleted.length > 0;
}

const claimedColumns = {
  runId: scheduledRuns.id,
  jobId: scheduledJobs.id,
  userId: scheduledJobs.userId,
  eveSessionId: scheduledJobs.eveSessionId,
  conversation: scheduledJobs.externalConversationId,
  handle: scheduledJobs.deliveryHandle,
  title: scheduledJobs.title,
  instruction: scheduledJobs.instruction,
  scheduledFor: scheduledRuns.scheduledFor,
  attempts: scheduledRuns.attempts,
};

/**
 * Leases due work for one dispatcher tick (spec §13.1). In one transaction:
 * 1. report turns that outlived their lease are failed, and so are occurrences whose report was never accepted
 *    after MAX_ATTEMPTS claims;
 * 2. occurrences whose earlier claim expired before their report was accepted (a crash between claim and
 *    hand-off) are leased again;
 * 3. due enabled schedules get a new occurrence row (unique per schedule and time, so overlapping ticks cannot
 *    double-claim) and their next occurrence is advanced past `now`.
 */
export async function claimDueRuns(db: Database, now = new Date(), limit = 20): Promise<ClaimedRun[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return db.transaction(async (tx) => {
    await tx
      .update(scheduledRuns)
      .set({ status: "failed", outcome: "The report did not finish within its time limit.", updatedAt: now })
      .where(and(eq(scheduledRuns.status, "reporting"), lt(scheduledRuns.leaseExpiresAt, now)));
    await tx
      .update(scheduledRuns)
      .set({ status: "failed", outcome: "The report could not be handed off.", updatedAt: now })
      .where(
        and(
          eq(scheduledRuns.status, "leased"),
          lt(scheduledRuns.leaseExpiresAt, now),
          sql`${scheduledRuns.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      );

    const retried = await tx
      .update(scheduledRuns)
      .set({ attempts: sql`${scheduledRuns.attempts} + 1`, leaseExpiresAt: leaseUntil, updatedAt: now })
      .where(
        inArray(
          scheduledRuns.id,
          tx
            .select({ id: scheduledRuns.id })
            .from(scheduledRuns)
            .where(and(eq(scheduledRuns.status, "leased"), lt(scheduledRuns.leaseExpiresAt, now)))
            .limit(limit)
            .for("update", { skipLocked: true }),
        ),
      )
      .returning({ id: scheduledRuns.id });

    const due = await tx
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.enabled, true), lte(scheduledJobs.nextRunAt, now)))
      .orderBy(scheduledJobs.nextRunAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const created: string[] = [];
    for (const job of due) {
      const scheduledFor = job.nextRunAt as Date;
      const [run] = await tx
        .insert(scheduledRuns)
        .values({ jobId: job.id, userId: job.userId, scheduledFor, status: "leased", leaseExpiresAt: leaseUntil })
        .onConflictDoNothing()
        .returning({ id: scheduledRuns.id });
      if (run) created.push(run.id);
      await tx
        .update(scheduledJobs)
        .set({ nextRunAt: nextOccurrence(job, scheduledFor, now), lastRunAt: now, updatedAt: now })
        .where(eq(scheduledJobs.id, job.id));
    }

    const ids = [...retried.map((run) => run.id), ...created];
    if (ids.length === 0) return [];
    return tx
      .select(claimedColumns)
      .from(scheduledRuns)
      .innerJoin(scheduledJobs, eq(scheduledJobs.id, scheduledRuns.jobId))
      .where(inArray(scheduledRuns.id, ids));
  });
}

/**
 * Whether a scheduled run may keep going: it exists for this user, its report is pending or underway, its lease
 * has not expired, and its schedule still exists and is enabled. Checked before every model call of the report.
 */
export async function scheduledRunActive(db: Database, runId: string, userId: string, now = new Date()) {
  const [row] = await db
    .select({ id: scheduledRuns.id })
    .from(scheduledRuns)
    .innerJoin(scheduledJobs, eq(scheduledJobs.id, scheduledRuns.jobId))
    .where(
      and(
        eq(scheduledRuns.id, runId),
        eq(scheduledRuns.userId, userId),
        eq(scheduledJobs.userId, userId),
        inArray(scheduledRuns.status, ["leased", "reporting"]),
        gt(scheduledRuns.leaseExpiresAt, now),
        eq(scheduledJobs.enabled, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Records that the run's report turn started, so the occurrence is never handed off again. */
export async function markReporting(db: Database, runId: string, userId: string, now = new Date()) {
  const updated = await db
    .update(scheduledRuns)
    .set({ status: "reporting", updatedAt: now })
    .where(
      and(
        eq(scheduledRuns.id, runId),
        eq(scheduledRuns.userId, userId),
        inArray(scheduledRuns.status, ["leased", "reporting"]),
        gt(scheduledRuns.leaseExpiresAt, now),
      ),
    )
    .returning({ id: scheduledRuns.id });
  return updated.length > 0;
}

/** Final settlement of a run that has not settled yet; later settlements are ignored. */
export async function settleScheduledRun(
  db: Database,
  runId: string,
  userId: string,
  status: "completed" | "failed" | "suppressed",
  outcome: string | null,
) {
  await db
    .update(scheduledRuns)
    .set({ status, outcome: outcome?.slice(0, OUTCOME_MAX) ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(scheduledRuns.id, runId),
        eq(scheduledRuns.userId, userId),
        inArray(scheduledRuns.status, ["leased", "reporting"]),
      ),
    );
}
