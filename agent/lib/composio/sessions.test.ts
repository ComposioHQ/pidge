import { EveProvider } from "@composio/experimental/eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimConversation, getBinding } from "../../../db/services/conversations";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { imessagePrincipal, webPrincipal } from "../identity/principal";

const created: { userId: string; config: unknown }[] = [];
const used: string[] = [];
let counter = 0;

vi.mock("./client", () => ({
  composio: () => ({
    create: async (userId: string, config: unknown) => {
      created.push({ userId, config });
      const sessionId = `trs_${++counter}`;
      return { sessionId, tools: async () => ({}) };
    },
    use: async (sessionId: string) => {
      used.push(sessionId);
      return { sessionId, tools: async () => ({}) };
    },
  }),
}));

const { resolveConversationTools, sessionConfig, toolkitPolicy, withApprovalPrompts } = await import("./sessions");

function context(sessionId: string, auth: ReturnType<typeof webPrincipal> | null) {
  return { session: { id: sessionId, auth: { current: auth } } };
}

describe("toolkit policy (§9.3)", () => {
  it("exposes the whole catalog except browser toolkits by default", () => {
    expect(toolkitPolicy(undefined, undefined)).toEqual({ kind: "disable", toolkits: ["browser_use", "browser_tool"] });
  });

  it("treats an explicitly empty allowlist as no app toolkits at all", () => {
    expect(toolkitPolicy([], undefined)).toEqual({ kind: "none" });
    expect(toolkitPolicy(["browser_use"], undefined)).toEqual({ kind: "none" });
  });

  it("never lets an allowlist or denylist re-enable browser toolkits", () => {
    expect(toolkitPolicy(["slack", "browser_tool", "gmail"], ["gmail"])).toEqual({
      kind: "enable",
      toolkits: ["slack"],
    });
    expect(toolkitPolicy(undefined, ["github"])).toEqual({
      kind: "disable",
      toolkits: ["browser_use", "browser_tool", "github"],
    });
  });

  it("disables workbench, bash and proxy execution and requires explicit account selection", () => {
    expect(
      sessionConfig({ kind: "disable", toolkits: ["browser_use"] }, "https://pidge.test/connections/complete"),
    ).toEqual({
      toolkits: { disable: ["browser_use"] },
      manageConnections: { enable: true, callbackUrl: "https://pidge.test/connections/complete" },
      sandbox: { enable: false },
      proxyExecute: false,
      multiAccount: { enable: true, requireExplicitSelection: true },
    });
  });
});

describe("per-conversation Composio sessions (§9.2)", () => {
  beforeEach(async () => {
    await resetDb();
    created.length = 0;
    used.length = 0;
  });

  it("creates one session per conversation with the internal user UUID, then restores it", async () => {
    const alice = await makeUser("Alice");
    await claimConversation(testDb(), {
      eveSessionId: "wrun_a",
      userId: alice,
      channel: "web",
      externalConversationId: null,
      deliveryHandle: null,
    });
    await resolveConversationTools(context("wrun_a", webPrincipal(alice)));
    expect(created).toHaveLength(1);
    expect(created[0]?.userId).toBe(alice);
    const stored = (await getBinding(testDb(), "wrun_a"))?.composioSessionId;
    expect(stored).toMatch(/^trs_/);

    await resolveConversationTools(context("wrun_a", webPrincipal(alice)));
    expect(created).toHaveLength(1);
  });

  it("gives a second conversation, and a different user, a different session", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    for (const [session, user] of [
      ["wrun_a1", alice],
      ["wrun_a2", alice],
      ["wrun_b1", bob],
    ] as const) {
      await claimConversation(testDb(), {
        eveSessionId: session,
        userId: user,
        channel: "web",
        externalConversationId: null,
        deliveryHandle: null,
      });
      await resolveConversationTools(context(session, webPrincipal(user)));
    }
    expect(created.map((entry) => entry.userId)).toEqual([alice, alice, bob]);
    const ids = await Promise.all(
      ["wrun_a1", "wrun_a2", "wrun_b1"].map(async (s) => (await getBinding(testDb(), s))?.composioSessionId),
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("fails closed when the principal is not the conversation owner", async () => {
    const alice = await makeUser("Alice");
    const mallory = await makeUser("Mallory");
    await claimConversation(testDb(), {
      eveSessionId: "wrun_a",
      userId: alice,
      channel: "imessage",
      externalConversationId: "thread-a",
      deliveryHandle: "+14155550100",
    });
    await expect(
      resolveConversationTools(context("wrun_a", imessagePrincipal(mallory, "thread-a", "+14155550100"))),
    ).rejects.toThrow();
    expect(created).toHaveLength(0);
  });

  it("returns no tools without a Pidge principal and never contacts Composio", async () => {
    const source = await resolveConversationTools(context("wrun_x", null));
    expect(await source.tools()).toEqual({});
    expect(created).toHaveLength(0);
    expect(used).toHaveLength(0);
  });
});

describe("approval prompts on provider tools", () => {
  it("adds a durable prompt while keeping the provider's approval policy and executor", async () => {
    const provider = new EveProvider({ needsApproval: () => true });
    const tools = provider.wrapTools(
      [
        {
          slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
          name: "Multi execute",
          description: "Run tools",
          inputParameters: { type: "object", properties: {} },
        } as never,
      ],
      async () => ({ data: {}, error: null, successful: true }),
    );
    const original = tools.COMPOSIO_MULTI_EXECUTE_TOOL;
    const wrapped = withApprovalPrompts(tools).COMPOSIO_MULTI_EXECUTE_TOOL as unknown as {
      approval: { request: unknown; prompt: (args: { input: unknown }) => string };
      execute: unknown;
    };
    expect(wrapped.approval.request).toBe(original?.approval);
    expect(wrapped.execute).toBe(original?.execute);
    const prompt = wrapped.approval.prompt({
      input: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#launch", text: "hi" } }] },
    });
    expect(prompt).toContain("channel: #launch");
    const callbacks = (wrapped as unknown as Record<symbol, Record<string, unknown>>)[
      Symbol.for("eve:durable-dynamic-tool-callbacks")
    ];
    expect(Object.keys(callbacks ?? {})).toEqual(
      expect.arrayContaining(["execute", "approvalRequest", "approvalPrompt"]),
    );
  });
});
