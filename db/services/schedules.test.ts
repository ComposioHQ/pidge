import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { scheduledJobs, scheduledRuns, settings } from "../schema";
import {
  claimDueRuns,
  createSchedule,
  deleteSchedule,
  LEASE_MS,
  listSchedules,
  MAX_ATTEMPTS,
  markReporting,
  type ScheduleOrigin,
  scheduledRunActive,
  settleScheduledRun,
  updateSchedule,
} from "./schedules";

const NOW = new Date("2026-11-05T20:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

async function origin(name: string): Promise<ScheduleOrigin> {
  const userId = await makeUser(name);
  await testDb().update(settings).set({ timezone: "America/Los_Angeles" }).where(eq(settings.userId, userId));
  return { userId, eveSessionId: `wrun_${name}`, conversation: `imessage:${name}`, handle: "+14155550100" };
}

async function once(owner: ScheduleOrigin, at = later(60_000)) {
  const created = await createSchedule(
    testDb(),
    owner,
    { title: "Dinner details", instruction: "Send the booking details.", cadence: { kind: "once", at } },
    NOW,
  );
  if (!created.ok) throw new Error(created.error);
  return created.job;
}

describe("schedules", () => {
  beforeEach(resetDb);

  it("takes the timezone from the owner's settings and keeps schedules private to their owner", async () => {
    const alice = await origin("Alice");
    const bob = await origin("Bob");
    const job = await once(alice);
    expect(job.timezone).toBe("America/Los_Angeles");

    expect(await listSchedules(testDb(), bob.userId)).toEqual([]);
    expect(await updateSchedule(testDb(), bob.userId, job.id, { enabled: false })).toMatchObject({ ok: false });
    expect(await deleteSchedule(testDb(), bob.userId, job.id)).toBe(false);
    const [row] = await testDb().select().from(scheduledJobs);
    expect(row?.enabled).toBe(true);
  });

  it("claims a due one-time schedule exactly once, even with overlapping ticks", async () => {
    const alice = await origin("Alice");
    const job = await once(alice);
    expect(await claimDueRuns(testDb(), NOW)).toEqual([]);

    const due = later(2 * 60_000);
    const [a, b] = await Promise.all([claimDueRuns(testDb(), due), claimDueRuns(testDb(), due)]);
    const claimed = [...(a ?? []), ...(b ?? [])];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ jobId: job.id, userId: alice.userId, conversation: "imessage:Alice" });
    expect(await claimDueRuns(testDb(), later(3 * 60_000))).toEqual([]);
    const [row] = await testDb().select().from(scheduledJobs);
    expect(row?.nextRunAt).toBeNull();
  });

  it("re-leases a claim whose report was never accepted, but never one whose report started", async () => {
    const alice = await origin("Alice");
    await once(alice);
    const [first] = await claimDueRuns(testDb(), later(60_000));
    if (!first) throw new Error("not claimed");

    const afterLease = later(60_000 + LEASE_MS + 1000);
    const [retry] = await claimDueRuns(testDb(), afterLease);
    expect(retry).toMatchObject({ runId: first.runId, attempts: 2 });

    expect(await markReporting(testDb(), first.runId, alice.userId, afterLease)).toBe(true);
    const muchLater = new Date(afterLease.getTime() + LEASE_MS + 1000);
    expect(await claimDueRuns(testDb(), muchLater)).toEqual([]);
    const [run] = await testDb().select().from(scheduledRuns);
    expect(run?.status).toBe("failed");
  });

  it("gives up on an occurrence after the maximum number of hand-off attempts", async () => {
    const alice = await origin("Alice");
    await once(alice);
    let at = later(60_000);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await claimDueRuns(testDb(), at)).toHaveLength(1);
      at = new Date(at.getTime() + LEASE_MS + 1000);
    }
    expect(await claimDueRuns(testDb(), at)).toEqual([]);
    const [run] = await testDb().select().from(scheduledRuns);
    expect(run).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("stops an in-flight run when its schedule is paused or deleted, its lease expires, or another user asks", async () => {
    const alice = await origin("Alice");
    const bob = await origin("Bob");
    const job = await once(alice);
    const claimedAt = later(60_000);
    const [run] = await claimDueRuns(testDb(), claimedAt);
    if (!run) throw new Error("not claimed");

    expect(await scheduledRunActive(testDb(), run.runId, alice.userId, claimedAt)).toBe(true);
    expect(await scheduledRunActive(testDb(), run.runId, bob.userId, claimedAt)).toBe(false);
    expect(await markReporting(testDb(), run.runId, bob.userId, claimedAt)).toBe(false);
    expect(await scheduledRunActive(testDb(), run.runId, alice.userId, later(60_000 + LEASE_MS + 1))).toBe(false);

    await updateSchedule(testDb(), alice.userId, job.id, { enabled: false }, claimedAt);
    expect(await scheduledRunActive(testDb(), run.runId, alice.userId, claimedAt)).toBe(false);
    await updateSchedule(testDb(), alice.userId, job.id, { enabled: true }, claimedAt);
    expect(await scheduledRunActive(testDb(), run.runId, alice.userId, claimedAt)).toBe(true);

    await deleteSchedule(testDb(), alice.userId, job.id);
    expect(await scheduledRunActive(testDb(), run.runId, alice.userId, claimedAt)).toBe(false);
  });

  it("settles a run once; later settlements don't overwrite it", async () => {
    const alice = await origin("Alice");
    await once(alice);
    const [run] = await claimDueRuns(testDb(), later(60_000));
    if (!run) throw new Error("not claimed");
    await settleScheduledRun(testDb(), run.runId, alice.userId, "completed", "Here are your dinner details…");
    await settleScheduledRun(testDb(), run.runId, alice.userId, "failed", "The report turn failed.");
    const [row] = await testDb().select().from(scheduledRuns);
    expect(row).toMatchObject({ status: "completed", outcome: "Here are your dinner details…" });
  });

  it("advances a recurring schedule in local time and does not replay runs missed while paused", async () => {
    const alice = await origin("Alice");
    const created = await createSchedule(
      testDb(),
      alice,
      { title: "Briefing", instruction: "Morning briefing.", cadence: { kind: "recurring", cron: "0 8 * * *" } },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    expect(created.job.nextRunAt?.toISOString()).toBe("2026-11-06T16:00:00.000Z");

    const [run] = await claimDueRuns(testDb(), new Date("2026-11-06T16:00:30Z"));
    expect(run?.scheduledFor.toISOString()).toBe("2026-11-06T16:00:00.000Z");
    await updateSchedule(testDb(), alice.userId, created.job.id, { enabled: false });
    const resumed = await updateSchedule(
      testDb(),
      alice.userId,
      created.job.id,
      { enabled: true },
      new Date("2026-11-10T20:00:00Z"),
    );
    expect(resumed.ok && resumed.job.nextRunAt?.toISOString()).toBe("2026-11-11T16:00:00.000Z");
  });
});
