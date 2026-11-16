import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { claimApprovedExecution, parkApproval } from "./approval-guards";

describe("approval guards", () => {
  beforeEach(resetDb);

  it("lets an approved call run exactly once in the process that parked it", async () => {
    const alice = await makeUser("Alice");
    const call = { callId: "toolu_1", userId: alice, eveSessionId: "wrun_a", bootId: "boot-1" };
    await parkApproval(testDb(), call);
    expect(await claimApprovedExecution(testDb(), call)).toEqual({ ok: true });
    // A step re-run after a crash mid-request must not repeat the side effect.
    expect(await claimApprovedExecution(testDb(), call)).toEqual({ ok: false, reason: "already_started" });
  });

  it("fails closed when the approval was parked before a restart", async () => {
    const alice = await makeUser("Alice");
    await parkApproval(testDb(), { callId: "toolu_2", userId: alice, eveSessionId: "wrun_a", bootId: "boot-1" });
    // Re-evaluating the policy in the new process does not re-home the parked approval.
    await parkApproval(testDb(), { callId: "toolu_2", userId: alice, eveSessionId: "wrun_a", bootId: "boot-2" });
    expect(
      await claimApprovedExecution(testDb(), {
        callId: "toolu_2",
        userId: alice,
        eveSessionId: "wrun_a",
        bootId: "boot-2",
      }),
    ).toEqual({ ok: false, reason: "restarted" });
  });

  it("does not honor another user's or conversation's approval record", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await parkApproval(testDb(), { callId: "toolu_3", userId: alice, eveSessionId: "wrun_a", bootId: "boot-1" });
    expect(
      await claimApprovedExecution(testDb(), {
        callId: "toolu_3",
        userId: bob,
        eveSessionId: "wrun_a",
        bootId: "boot-1",
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      await claimApprovedExecution(testDb(), {
        callId: "toolu_3",
        userId: alice,
        eveSessionId: "wrun_b",
        bootId: "boot-1",
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
