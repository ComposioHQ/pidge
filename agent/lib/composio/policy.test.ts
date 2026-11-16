import { describe, expect, it } from "vitest";
import { approvalPrompt, classifyAppTool, classifyComposioCall, type ToolHints } from "./policy";

const readOnly: ToolHints = { readOnly: true, destructive: false };
const write: ToolHints = { readOnly: false, destructive: false };

const hints: Record<string, ToolHints> = {
  GMAIL_FETCH_EMAILS: { ...readOnly, toolkit: "gmail" },
  LINEAR_LIST_ISSUES: { ...readOnly, toolkit: "linear" },
  NOTION_ADD_PAGE_CONTENT: { ...write, toolkit: "notion" },
  GOOGLEDRIVE_EMPTY_FOLDER: { readOnly: false, destructive: true, toolkit: "googledrive" },
  SLACK_SEND_MESSAGE: { ...write, toolkit: "slack" },
  GMAIL_SEND_EMAIL: { ...write, toolkit: "gmail" },
  OPENTABLE_BOOK_TABLE: { ...write, toolkit: "opentable" },
  STRIPE_CREATE_REFUND: { ...write, toolkit: "stripe" },
};
const lookup = (slug: string) => hints[slug] ?? null;

function batch(...slugs: string[]) {
  return { tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) };
}

describe("Composio approval baseline (§9.7)", () => {
  it("runs read-only tools without approval", () => {
    expect(classifyAppTool("GMAIL_FETCH_EMAILS", lookup("GMAIL_FETCH_EMAILS"))).toEqual({
      slug: "GMAIL_FETCH_EMAILS",
      risk: "read",
      approval: false,
    });
    expect(
      classifyComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", batch("LINEAR_LIST_ISSUES", "GMAIL_FETCH_EMAILS"), lookup)
        .approval,
    ).toBe(false);
  });

  it("requires approval for destructive tools even without risky words", () => {
    expect(classifyAppTool("GOOGLEDRIVE_EMPTY_FOLDER", lookup("GOOGLEDRIVE_EMPTY_FOLDER")).risk).toBe("destructive");
  });

  it("requires approval for high-risk action words", () => {
    for (const slug of ["OPENTABLE_BOOK_TABLE", "STRIPE_CREATE_REFUND", "GITHUB_DELETE_REPO", "DRIVE_SHARE_FILE"]) {
      const decision = classifyAppTool(slug, lookup(slug));
      expect(decision).toMatchObject({ risk: "high_risk", approval: true });
    }
  });

  it("requires approval for outbound communication", () => {
    for (const slug of [
      "SLACK_SEND_MESSAGE",
      "GMAIL_SEND_EMAIL",
      "GITHUB_CREATE_ISSUE_COMMENT",
      "SLACK_CHAT_POST_MESSAGE",
    ]) {
      expect(classifyAppTool(slug, lookup(slug))).toMatchObject({ risk: "outbound", approval: true });
    }
  });

  it("does not let a read-only hint override risky action words", () => {
    expect(classifyAppTool("GMAIL_SEND_EMAIL", { readOnly: true, destructive: false, toolkit: "gmail" }).approval).toBe(
      true,
    );
  });

  it("requires approval for other writes and for tools with unknown metadata (D9)", () => {
    expect(classifyAppTool("NOTION_ADD_PAGE_CONTENT", lookup("NOTION_ADD_PAGE_CONTENT"))).toMatchObject({
      risk: "other_write",
      approval: true,
    });
    expect(classifyAppTool("SOMEAPP_UPDATE_THING", null)).toMatchObject({ risk: "other_write", approval: true });
  });

  it("evaluates every multi-execute entry: one unapproved write in a batch of reads needs approval", () => {
    const decision = classifyComposioCall(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      batch("LINEAR_LIST_ISSUES", "SLACK_SEND_MESSAGE", "GMAIL_FETCH_EMAILS"),
      lookup,
    );
    expect(decision.approval).toBe(true);
    expect(decision.entries.map((entry) => entry.approval)).toEqual([false, true, false]);
  });

  it("asks for approval on malformed or empty batches", () => {
    expect(classifyComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: "SLACK_SEND_MESSAGE" }, lookup).approval).toBe(
      true,
    );
    expect(classifyComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }, lookup).approval).toBe(true);
    expect(classifyComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ arguments: {} }] }, lookup).approval).toBe(
      true,
    );
  });

  it("needs approval to replace or remove connections but not to add or check one", () => {
    const manage = (input: unknown) => classifyComposioCall("COMPOSIO_MANAGE_CONNECTIONS", input, lookup).approval;
    expect(manage({ toolkits: [{ name: "slack", action: "add" }] })).toBe(false);
    expect(manage({ toolkits: [{ name: "slack", action: "list" }] })).toBe(false);
    expect(manage({ toolkits: [{ name: "slack" }] })).toBe(false);
    expect(manage({ reinitiate_all: true })).toBe(true);
    expect(manage({ toolkits: [{ name: "slack", action: "remove" }] })).toBe(true);
    expect(
      manage({
        toolkits: [
          { name: "slack", action: "list" },
          { name: "gmail", action: "reconnect" },
        ],
      }),
    ).toBe(true);
  });

  it("never treats search or schema lookups as needing approval", () => {
    expect(classifyComposioCall("COMPOSIO_SEARCH_TOOLS", { queries: [] }, lookup).approval).toBe(false);
    expect(classifyComposioCall("COMPOSIO_GET_TOOL_SCHEMAS", {}, lookup).approval).toBe(false);
  });

  it("marks browser toolkit slugs as denied wherever they appear", () => {
    const decision = classifyComposioCall(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      batch("GMAIL_FETCH_EMAILS", "BROWSER_TOOL_CREATE_TASK"),
      lookup,
    );
    expect(decision.entries[1]).toMatchObject({ risk: "browser_denied", approval: true });
    expect(classifyAppTool("BROWSER_USE_START_RUN", null).risk).toBe("browser_denied");
  });
});

describe("approval prompts", () => {
  it("shows the destination and content of every entry, and hides credential-like fields", () => {
    const prompt = approvalPrompt("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        { tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#launch", text: "Release notes v2.1 are out" } },
        { tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "me@example.com", api_key: "sk_live_123" } },
      ],
    });
    expect(prompt).toContain("Approve these 2 actions?");
    expect(prompt).toContain("SLACK_SEND_MESSAGE");
    expect(prompt).toContain("channel: #launch");
    expect(prompt).toContain("text: Release notes v2.1 are out");
    expect(prompt).toContain("recipient_email: me@example.com");
    expect(prompt).not.toContain("sk_live_123");
    expect(prompt).toContain("api_key: [hidden]");
  });

  it("stays bounded for very large inputs", () => {
    const prompt = approvalPrompt("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: Array.from({ length: 30 }, () => ({
        tool_slug: "SLACK_SEND_MESSAGE",
        arguments: { text: "x".repeat(2000) },
      })),
    });
    expect(prompt.length).toBeLessThan(2000);
  });
});
