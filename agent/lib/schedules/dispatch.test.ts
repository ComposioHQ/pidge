import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { scheduledRuns, settings } from "../../../db/schema";
import { claimConversation } from "../../../db/services/conversations";
import { createSchedule } from "../../../db/services/schedules";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { readPrincipal } from "../identity/principal";
import { dispatchDue, type SendReport } from "./dispatch";

const THREAD = "imessage:any;-;+14155550100";
const HANDLE = "+14155550100";
const NOW = new Date("2026-11-05T20:00:00Z");
const DUE = new Date("2026-11-05T20:02:00Z");

async function setup(linked: boolean) {
  const alice = await makeUser("Alice");
  await testDb().update(settings).set({ timezone: "America/Los_Angeles" }).where(eq(settings.userId, alice));
  await claimConversation(testDb(), {
    eveSessionId: "wrun_alice",
    userId: alice,
    channel: "imessage",
    externalConversationId: THREAD,
    deliveryHandle: HANDLE,
  });
  if (linked) {
    const { channelIdentities } = await import("../../../db/schema");
    await testDb().insert(channelIdentities).values({ userId: alice, channel: "imessage", normalizedHandle: HANDLE });
  }
  await createSchedule(
    testDb(),
    { userId: alice, eveSessionId: "wrun_alice", conversation: THREAD, handle: HANDLE },
    {
      title: "Dinner",
      instruction: "Text the booking details and directions.",
      cadence: { kind: "once", at: new Date("2026-11-05T20:01:00Z") },
    },
    NOW,
  );
  return alice;
}

describe("schedule dispatch", () => {
  beforeEach(resetDb);

  it("hands a due run to its originating conversation as the schedule's creator", async () => {
    const alice = await setup(true);
    const sent: Parameters<SendReport>[] = [];
    await dispatchDue(testDb(), async (...args) => void sent.push(args), DUE);
    expect(sent).toHaveLength(1);
    const [run, message, auth] = sent[0] as Parameters<SendReport>;
    expect(run.conversation).toBe(THREAD);
    expect(message).toContain("Text the booking details and directions.");
    expect(readPrincipal(auth)).toEqual({
      userId: alice,
      channel: "imessage",
      conversation: THREAD,
      handle: HANDLE,
      scheduledRunId: run.runId,
    });
    const [row] = await testDb().select().from(scheduledRuns);
    expect(row?.status).toBe("reporting");
  });

  it("suppresses delivery to a destination that was unlinked", async () => {
    await setup(false);
    let sends = 0;
    await dispatchDue(
      testDb(),
      async () => {
        sends++;
      },
      DUE,
    );
    expect(sends).toBe(0);
    const [row] = await testDb().select().from(scheduledRuns);
    expect(row?.status).toBe("suppressed");
  });

  it("keeps a failed hand-off leased so a later tick can retry it", async () => {
    await setup(true);
    await dispatchDue(
      testDb(),
      async () => {
        throw new Error("photon unavailable");
      },
      DUE,
    );
    const [row] = await testDb().select().from(scheduledRuns);
    expect(row?.status).toBe("leased");
  });
});
