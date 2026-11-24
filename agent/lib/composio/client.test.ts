import { EveProvider } from "@composio/experimental/eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionAudit } from "../../../db/schema";
import {
  activateSubscription,
  claimEvents,
  ingestEvent,
  reserveSubscription,
  startEvent,
  stopSubscription,
} from "../../../db/services/triggers";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { triggerPrincipal, webPrincipal } from "../identity/principal";
import { approvalPolicy, entryOutcomes, executeHook } from "./client";

type HookArgs = Parameters<typeof executeHook>;
type PolicyArgs = Parameters<typeof approvalPolicy>;

function hookContext(
  slug: string,
  args: Record<string, unknown>,
  auth: ReturnType<typeof webPrincipal> | null,
  callId = "toolu_test",
) {
  const denied: string[] = [];
  const session = { id: "wrun_test", auth: { current: auth } };
  const ctx = {
    request: { slug, args },
    context: { slug, eve: { session, callId } },
    deny: (reason: string) => {
      denied.push(reason);
      return { data: {}, error: reason, successful: false };
    },
  } as unknown as HookArgs[0];
  /** What eve does before parking the call: evaluate the central approval policy. */
  const requestApproval = () =>
    approvalPolicy(
      { slug } as unknown as PolicyArgs[0],
      { callId, session, toolInput: args } as unknown as PolicyArgs[1],
    );
  return { ctx, denied, requestApproval };
}

/** A fresh eve process identity, as after `systemctl restart`. */
function simulateRestart() {
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pidge.composio.bootId")];
}

describe("Composio execute hook", () => {
  beforeEach(resetDb);

  it("denies Browser Use and browser_tool slugs before any provider call, inside batches too", async () => {
    const alice = await makeUser("Alice");
    for (const args of [
      { tools: [{ tool_slug: "BROWSER_USE_START_RUN", arguments: { task: "x", max_cost_usd: 1 } }] },
      { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "BROWSER_TOOL_CREATE_TASK" }] },
    ]) {
      const next = vi.fn();
      const { ctx, denied } = hookContext("COMPOSIO_MULTI_EXECUTE_TOOL", args, webPrincipal(alice));
      const result = await executeHook(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(denied).toHaveLength(1);
      expect(result).toMatchObject({ successful: false });
    }
    const rows = await testDb().select().from(actionAudit);
    expect(rows.filter((row) => row.outcome === "denied").map((row) => row.toolSlug)).toContain(
      "BROWSER_TOOL_CREATE_TASK",
    );
  });

  it("refuses calls without an authenticated Pidge principal", async () => {
    const next = vi.fn();
    const { ctx, denied } = hookContext(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "SLACK_SEND_MESSAGE" }] },
      null,
    );
    await executeHook(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(denied).toHaveLength(1);
  });

  it("calls the provider exactly once and records a failed write without retrying or storing arguments", async () => {
    const alice = await makeUser("Alice");
    const next = vi.fn(async () => ({ data: {}, error: "upstream timeout", successful: false, logId: "log_1" }));
    const { ctx, requestApproval } = hookContext(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#launch", text: "secret plans" } }] },
      webPrincipal(alice),
    );
    expect(await requestApproval()).toBe(true);
    const result = await executeHook(ctx, next as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ successful: false });
    const rows = await testDb().select().from(actionAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolSlug: "SLACK_SEND_MESSAGE",
      outcome: "failed",
      approval: "required",
      composioLogId: "log_1",
    });
    expect(JSON.stringify(rows)).not.toContain("secret plans");
  });

  it("keeps app-event writes behind the same approval guard and owner audit", async () => {
    const alice = await makeUser("Alice");
    const next = vi.fn(async () => ({ data: {}, error: null, successful: true }));
    const subscription = await reserveSubscription(testDb(), {
      userId: alice,
      requestKey: "event-test",
      eveSessionId: "wrun_test",
      conversation: "thread-event",
      handle: "+14155550100",
      connectedAccountId: "ca_test",
      toolkit: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      instruction: "Summarize it",
      config: {},
      status: "creating",
    });
    if (!subscription) throw new Error("no subscription");
    await activateSubscription(testDb(), subscription.id, "ti_test");
    await ingestEvent(testDb(), {
      triggerId: "ti_test",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      userId: alice,
      connectedAccountId: "ca_test",
      eventId: "log_test",
      payload: {},
    });
    const [event] = await claimEvents(testDb());
    if (!event) throw new Error("no event");
    await startEvent(testDb(), event.run.id, alice, "wrun_test", "thread-event", "+14155550100", "turn_event");
    const eventAuth = triggerPrincipal(alice, "thread-event", "+14155550100", event.run.id);
    const denied = hookContext("GMAIL_SEND_EMAIL", { to: "a@example.com" }, eventAuth, "event-unapproved");
    await executeHook(denied.ctx, next as never);
    expect(next).not.toHaveBeenCalled();
    const approved = hookContext("GMAIL_SEND_EMAIL", { to: "a@example.com" }, eventAuth, "event-approved");
    expect(await approved.requestApproval()).toBe(true);
    await executeHook(approved.ctx, next as never);
    await executeHook(approved.ctx, next as never);
    expect(next).toHaveBeenCalledOnce();
    const rows = await testDb().select().from(actionAudit);
    expect(rows.every((row) => row.userId === alice && row.approval === "required")).toBe(true);
    expect(rows.filter((row) => row.outcome === "completed")).toHaveLength(1);
    const beforeRestart = hookContext("GMAIL_SEND_EMAIL", {}, eventAuth, "event-then-restart");
    expect(await beforeRestart.requestApproval()).toBe(true);
    simulateRestart();
    await beforeRestart.requestApproval();
    await executeHook(beforeRestart.ctx, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(beforeRestart.denied[0]).toContain("restarted");
    const parked = hookContext("GMAIL_SEND_EMAIL", {}, eventAuth, "event-then-disabled");
    expect(await parked.requestApproval()).toBe(true);
    await stopSubscription(testDb(), alice, subscription.id);
    await executeHook(parked.ctx, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(parked.denied[0]).toContain("stopped or expired");
  });

  it("does not retry when the provider call throws", async () => {
    const alice = await makeUser("Alice");
    const next = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const { ctx, requestApproval } = hookContext(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] },
      webPrincipal(alice),
    );
    await requestApproval();
    await expect(executeHook(ctx, next as never)).rejects.toThrow("socket hang up");
    expect(next).toHaveBeenCalledTimes(1);
    const rows = await testDb().select().from(actionAudit);
    expect(rows[0]?.outcome).toBe("error");
  });

  it("never runs an approved write twice, even when a crash makes eve re-run the step", async () => {
    const alice = await makeUser("Alice");
    const next = vi.fn(async () => ({ data: {}, error: null, successful: true, logId: "log_2" }));
    const call = hookContext(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#launch", text: "hi" } }] },
      webPrincipal(alice),
      "toolu_rerun",
    );
    await call.requestApproval();
    await executeHook(call.ctx, next as never);
    simulateRestart();
    const rerun = await executeHook(call.ctx, next as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(rerun).toMatchObject({ successful: false });
  });

  it("fails closed when Pidge restarts while an approval is waiting", async () => {
    const alice = await makeUser("Alice");
    const next = vi.fn(async () => ({ data: {}, error: null, successful: true, logId: "log_3" }));
    const call = hookContext(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } }] },
      webPrincipal(alice),
      "toolu_parked",
    );
    await call.requestApproval();
    simulateRestart();
    // eve re-checks the policy in the new process when the person approves; that must not re-home the approval.
    await call.requestApproval();
    const result = await executeHook(call.ctx, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(result).toMatchObject({ successful: false });
    expect(call.denied[0]).toContain("restarted");
  });
});

describe("session result interpretation", () => {
  it("uses the session result status, not a tool-specific success field", () => {
    // `successful` is derived by the SDK from Composio's resultType; a tool payload claiming success does not count.
    expect(entryOutcomes(["SLACK_SEND_MESSAGE"], { successful: false, data: { successful: true } })).toEqual([
      "failed",
    ]);
    expect(
      entryOutcomes(["A_READ", "B_SEND"], {
        successful: true,
        data: {
          results: [
            { index: 0, response: {} },
            { index: 1, error: "channel_not_found" },
          ],
        },
      }),
    ).toEqual(["completed", "failed"]);
  });
});

describe("parked approvals across a restart", () => {
  it("fails closed when a parked call's binding belongs to another process", async () => {
    const provider = new EveProvider({ needsApproval: () => true });
    const execute = vi.fn(async () => ({ data: {}, error: null, successful: true }));
    const tools = provider.wrapTools(
      [
        {
          slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
          name: "m",
          inputParameters: { type: "object", properties: {} },
        } as never,
      ],
      execute,
    );
    const tool = tools.COMPOSIO_MULTI_EXECUTE_TOOL;
    if (!tool) throw new Error("tool missing");
    // The provider stamps eve's global durable-callback descriptor on its executor; reading it simulates a replay.
    const stamped = tool.execute as unknown as Record<symbol, unknown>;
    const descriptor = stamped[Symbol.for("eve:durable-dynamic-callback")] as {
      callback: (closure: unknown, input: unknown, ctx: unknown) => Promise<unknown>;
      closure: { slug: string };
    };
    // Replaying with the closure a previous process persisted (different process token) must not execute.
    const replayed = descriptor.callback(
      { slug: descriptor.closure.slug, binding: "previous-process:1" },
      { tools: [] },
      {},
    );
    await expect(replayed).rejects.toThrow(/no executor in this process/);
    expect(execute).not.toHaveBeenCalled();
  });
});
