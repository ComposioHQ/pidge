import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserTaskRuns, browserTasks } from "../../../db/schema";
import { makeUser, resetDb, testDb } from "../../../test/db";

const calls: { slug: string; args: Record<string, unknown>; sessionId: string }[] = [];
let createResponse: () => Promise<unknown> = async () => ({
  resultType: "completed",
  data: { watch_task_id: `task-${calls.length}`, browser_session_id: "bsess-1" },
  error: null,
});

vi.mock("../composio/client", () => ({
  composioAdmin: () => ({
    create: async () => ({ sessionId: "trs_browser" }),
    use: async (sessionId: string) => ({
      execute: async (slug: string, args: Record<string, unknown>) => {
        calls.push({ slug, args, sessionId });
        if (slug === "BROWSER_TOOL_CREATE_TASK") return createResponse();
        if (slug === "BROWSER_TOOL_WATCH_TASK") {
          return {
            resultType: "completed",
            data: { status: "finished", output: "Table for 2 at 7:00 PM" },
            error: null,
          };
        }
        return { resultType: "completed", data: {}, error: null };
      },
    }),
  }),
}));

const { openErrand, startRun, stopRun, watchRun } = await import("./runs-impl");

describe("browser runs", () => {
  beforeEach(async () => {
    await resetDb();
    calls.length = 0;
    createResponse = async () => ({
      resultType: "completed",
      data: { watch_task_id: `task-${calls.length}`, browser_session_id: "bsess-1" },
      error: null,
    });
  });

  it("persists remote IDs before reporting a start, and never starts twice for the same request", async () => {
    const alice = await makeUser("Alice");
    const errand = await openErrand({ userId: alice, eveSessionId: "wrun_a", summary: "Find dinner" });
    const input = { errand, userId: alice, requestKey: "call-1", mode: "research" as const, taskText: "RESEARCH ONLY" };
    const first = await startRun(input);
    expect(first).toMatchObject({ ok: true, remoteTaskId: "task-1" });
    const [row] = await testDb().select().from(browserTaskRuns);
    expect(row).toMatchObject({ status: "running", remoteTaskId: "task-1", userId: alice });

    const replay = await startRun(input);
    expect(replay).toEqual(first);
    expect(calls.filter((call) => call.slug === "BROWSER_TOOL_CREATE_TASK")).toHaveLength(1);
  });

  it("does not retry a start whose outcome is unknown", async () => {
    const alice = await makeUser("Alice");
    const errand = await openErrand({ userId: alice, eveSessionId: "wrun_a", summary: "Find dinner" });
    createResponse = async () => {
      throw new Error("socket hang up");
    };
    const input = { errand, userId: alice, requestKey: "call-2", mode: "research" as const, taskText: "RESEARCH ONLY" };
    expect(await startRun(input)).toMatchObject({ ok: false });
    expect(await startRun(input)).toMatchObject({ ok: false });
    expect(calls.filter((call) => call.slug === "BROWSER_TOOL_CREATE_TASK")).toHaveLength(1);
    const [row] = await testDb().select().from(browserTaskRuns);
    expect(row?.status).toBe("ambiguous");
  });

  it("refuses to watch or stop another user's run", async () => {
    const alice = await makeUser("Alice");
    const mallory = await makeUser("Mallory");
    const errand = await openErrand({ userId: alice, eveSessionId: "wrun_a", summary: "Find dinner" });
    const started = await startRun({
      errand,
      userId: alice,
      requestKey: "call-3",
      mode: "research",
      taskText: "RESEARCH ONLY",
    });
    if (!started.ok) throw new Error("start failed");
    await expect(watchRun({ runId: started.runId, userId: mallory })).rejects.toThrow();
    await expect(stopRun({ runId: started.runId, userId: mallory, superseded: false })).rejects.toThrow();
    expect(calls.filter((call) => call.slug !== "BROWSER_TOOL_CREATE_TASK")).toHaveLength(0);

    const watched = await watchRun({ runId: started.runId, userId: alice });
    expect(watched).toMatchObject({ terminal: true, output: "Table for 2 at 7:00 PM" });
  });

  it("marks a corrected run as superseded, not as the errand's outcome", async () => {
    const alice = await makeUser("Alice");
    const errand = await openErrand({ userId: alice, eveSessionId: "wrun_a", summary: "Find dinner" });
    const first = await startRun({
      errand,
      userId: alice,
      requestKey: "c1",
      mode: "research",
      taskText: "RESEARCH ONLY",
    });
    if (!first.ok) throw new Error("start failed");
    await stopRun({ runId: first.runId, userId: alice, superseded: true });
    const [run] = await testDb().select().from(browserTaskRuns).where(eq(browserTaskRuns.id, first.runId));
    expect(run?.status).toBe("superseded");
    expect(calls.some((call) => call.slug === "BROWSER_TOOL_STOP_TASK")).toBe(true);
    const [task] = await testDb().select().from(browserTasks);
    expect(task?.status).toBe("running");
  });
});
