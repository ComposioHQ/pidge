import { Composio } from "@composio/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelIdentities } from "../../../db/schema";
import { claimConversation } from "../../../db/services/conversations";
import { ingestEvent, listSubscriptions, recentEvents } from "../../../db/services/triggers";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { imessagePrincipal, scheduledPrincipal, triggerPrincipal, webPrincipal } from "../identity/principal";

const remote = vi.hoisted(() => ({
  getType: vi.fn(),
  listTypes: vi.fn(),
  listActive: vi.fn(),
  create: vi.fn(),
  disable: vi.fn(),
  delete: vi.fn(),
}));
const connections = vi.hoisted(() => vi.fn());
vi.mock("../composio/client", () => ({ composioAdmin: () => ({ triggers: remote }) }));
vi.mock("../composio/connections", () => ({ listConnections: connections }));
const { manageTriggers, triggerManager, triggerWrite } = await import("./subscriptions");
const HANDLE = "+14155550100";
const THREAD = "imessage:alice";
const SESSION = "wrun_alice";
const create = {
  action: "create" as const,
  connected_account_id: "ca_test",
  trigger_slug: "GITHUB_COMMIT_EVENT",
  config: { owner: "example", repo: "demo" },
  instruction: "Summarize the commit and link it here.",
};

async function setup() {
  const userId = await makeUser("Alice");
  await claimConversation(testDb(), {
    userId,
    eveSessionId: SESSION,
    channel: "imessage",
    externalConversationId: THREAD,
    deliveryHandle: HANDLE,
  });
  await testDb().insert(channelIdentities).values({ userId, channel: "imessage", normalizedHandle: HANDLE });
  const context = { auth: imessagePrincipal(userId, THREAD, HANDLE), sessionId: SESSION, callId: "tool_create_1" };
  connections.mockResolvedValue([{ id: "ca_test", toolkit: "github", status: "ACTIVE", alias: "test" }]);
  return { userId, context };
}

describe("app-event subscription lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    process.env.COMPOSIO_WEBHOOK_SECRET = "test-only-secret";
    remote.getType.mockResolvedValue({
      slug: "GITHUB_COMMIT_EVENT",
      toolkit: { slug: "github" },
      config: { required: ["owner", "repo"] },
    });
    remote.listTypes.mockResolvedValue({ items: [], nextCursor: "next-page" });
    remote.listActive.mockResolvedValue({ items: [] });
    remote.create.mockResolvedValue({ triggerId: "ti_test", type: "webhook", pollingInterval: null });
    remote.disable.mockResolvedValue({ status: "success" });
    remote.delete.mockResolvedValue({ triggerId: "ti_test" });
  });

  it("discovers schemas and owned accounts, creates against an explicit account, and makes replayed setup harmless", async () => {
    const { userId, context } = await setup();
    expect(
      await manageTriggers(testDb(), { action: "discover", toolkit: "github", slug: create.trigger_slug }, context),
    ).toMatchObject({ connections: [{ id: "ca_test" }], type: { config: { required: ["owner", "repo"] } } });
    await manageTriggers(testDb(), { action: "discover", toolkit: "github", cursor: "page-2" }, context);
    expect(remote.listTypes).toHaveBeenCalledWith({ toolkits: ["github"], limit: 20, cursor: "page-2" });
    expect(await manageTriggers(testDb(), create, context)).toMatchObject({
      status: "active",
      delivery: "this iMessage conversation",
    });
    expect(remote.create).toHaveBeenCalledWith(
      userId,
      create.trigger_slug,
      { connectedAccountId: "ca_test", triggerConfig: create.config },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
    await manageTriggers(testDb(), create, context);
    await manageTriggers(testDb(), create, { ...context, callId: "tool_create_2" });
    expect(remote.create).toHaveBeenCalledOnce();
    expect((await listSubscriptions(testDb(), userId))[0]).toMatchObject({
      instruction: create.instruction,
      connectedAccountId: "ca_test",
      status: "active",
    });
    expect(await manageTriggers(testDb(), { action: "list" }, context)).toMatchObject({
      subscriptions: [
        { config: create.config, instruction: create.instruction, delivery: "this iMessage conversation" },
      ],
    });
    expect(triggerWrite(create)).toBe(true);
    expect(triggerWrite({ action: "list" })).toBe(false);
  });

  it("passes the no-retry option through the installed SDK transport", async () => {
    const { context } = await setup();
    await manageTriggers(testDb(), create, context);
    const options = remote.create.mock.calls[0]?.[3];
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const sdk = new Composio({ apiKey: "test-only", allowTracking: false, baseURL: "https://composio.example.com" });
      vi.spyOn(sdk.triggers, "getType").mockResolvedValue({} as never);
      await expect(
        sdk.triggers.create("test-user", create.trigger_slug, { connectedAccountId: "ca_test" }, options),
      ).rejects.toThrow();
      expect(
        fetch.mock.calls.filter((call) => String((call as unknown[])[0]).includes("/trigger_instances/")),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses foreign/inactive accounts, mismatched app types and web destinations before a remote write", async () => {
    const { userId, context } = await setup();
    await expect(
      manageTriggers(testDb(), { ...create, connected_account_id: "ca_someone_else" }, context),
    ).rejects.toThrow("own active");
    connections.mockResolvedValueOnce([{ id: "ca_test", toolkit: "github", status: "EXPIRED" }]);
    await expect(manageTriggers(testDb(), create, context)).rejects.toThrow("own active");
    remote.getType.mockResolvedValueOnce({ slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: { slug: "gmail" } });
    await expect(manageTriggers(testDb(), create, context)).rejects.toThrow("same app");
    expect(await manageTriggers(testDb(), create, { ...context, auth: webPrincipal(userId) })).toMatchObject({
      status: "refused",
    });
    remote.listActive.mockResolvedValueOnce({ items: [{ id: "ti_existing" }] });
    expect(await manageTriggers(testDb(), create, context)).toMatchObject({
      status: "refused",
      error: expect.stringContaining("already has"),
    });
    expect(remote.create).not.toHaveBeenCalled();
  });

  it("allows only owner inspection and lifecycle changes, discards pending events on disable, and retains removed tombstones", async () => {
    const { userId, context } = await setup();
    await manageTriggers(testDb(), create, context);
    const sub = (await listSubscriptions(testDb(), userId))[0];
    if (!sub) throw new Error("no subscription");
    await ingestEvent(testDb(), {
      triggerId: "ti_test",
      userId,
      connectedAccountId: "ca_test",
      triggerSlug: create.trigger_slug,
      eventId: "log_1",
      payload: { message: "commit" },
    });
    const bob = await makeUser("Bob");
    const bobContext = { ...context, auth: webPrincipal(bob) };
    expect(await manageTriggers(testDb(), { action: "list" }, bobContext)).toEqual({ subscriptions: [], events: [] });
    expect(await manageTriggers(testDb(), { action: "remove", id: sub.id }, bobContext)).toEqual({
      status: "not_found",
    });
    expect(remote.delete).not.toHaveBeenCalled();
    expect(await manageTriggers(testDb(), { action: "disable", id: sub.id }, context)).toEqual({ status: "disabled" });
    expect(remote.disable).toHaveBeenCalledWith("ti_test", expect.objectContaining({ maxRetries: 0 }));
    expect((await recentEvents(testDb(), userId))[0]?.status).toBe("suppressed");
    expect(await manageTriggers(testDb(), { action: "remove", id: sub.id }, context)).toEqual({ status: "removed" });
    expect(await manageTriggers(testDb(), { action: "remove", id: sub.id }, context)).toEqual({ status: "removed" });
    expect(remote.delete).toHaveBeenCalledOnce();
    expect((await listSubscriptions(testDb(), userId))[0]?.status).toBe("removed");
  });

  it("blocks repeated uncertain creation, and stops locally even if remote disable fails", async () => {
    const { userId, context } = await setup();
    remote.create.mockRejectedValueOnce(new Error("timeout after remote upsert"));
    expect(await manageTriggers(testDb(), create, context)).toMatchObject({ status: "uncertain" });
    await manageTriggers(testDb(), create, { ...context, callId: "new_call" });
    expect(remote.create).toHaveBeenCalledOnce();
    expect((await listSubscriptions(testDb(), userId))[0]?.status).toBe("uncertain");
  });

  it("preserves a local disable if Composio cleanup fails and denies automated automation management", async () => {
    const { userId, context } = await setup();
    await manageTriggers(testDb(), create, context);
    const sub = (await listSubscriptions(testDb(), userId))[0];
    if (!sub) throw new Error("no subscription");
    remote.disable.mockRejectedValueOnce(new Error("offline"));
    expect(await manageTriggers(testDb(), { action: "disable", id: sub.id }, context)).toMatchObject({
      status: "disabled",
      error: expect.stringContaining("Stopped locally"),
    });
    for (const auth of [
      null,
      triggerPrincipal(userId, THREAD, HANDLE, "event_1"),
      scheduledPrincipal(userId, THREAD, HANDLE, "scheduled_1"),
    ]) {
      expect(triggerManager(auth)).toBeNull();
      expect(await manageTriggers(testDb(), create, { ...context, auth })).toMatchObject({ status: "refused" });
    }
    expect(remote.create).toHaveBeenCalledOnce();
  });
});
