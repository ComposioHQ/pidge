import { describe, expect, it, vi } from "vitest";
import { decideInbound, type IdentityLookup } from "./photon";
import { readPrincipal } from "./principal";

const THREAD = "imessage:any;-;+14155550100~shared";
const human = { userId: "(415) 555-0100", isBot: false as const, isMe: false };

function lookup(linked: Record<string, string> = {}, issue: { token: string } | null = { token: "tok_123" }) {
  return {
    findLinkedUser: vi.fn(async (handle: string) => linked[handle] ?? null),
    issueLinkToken: vi.fn(async () => issue),
    linkUrl: (token: string) => `https://pidge.test/link/imessage?token=${token}`,
  } satisfies IdentityLookup;
}

describe("Photon inbound identity policy", () => {
  it("ignores the line's own messages, bots, and senders whose bot status is unknown, before any lookup", async () => {
    for (const sender of [
      { ...human, isMe: true },
      { ...human, isBot: true },
      { ...human, isBot: "unknown" as const },
    ]) {
      const deps = lookup({ "+14155550100": "user-1" });
      const decision = await decideInbound(deps, { sender, isDM: true, conversation: THREAD, allowOnboarding: true });
      expect(decision.kind).toBe("ignore");
      expect(deps.findLinkedUser).not.toHaveBeenCalled();
      expect(deps.issueLinkToken).not.toHaveBeenCalled();
    }
  });

  it("rejects group conversations even from a linked sender", async () => {
    for (const isDM of [false, null]) {
      const deps = lookup({ "+14155550100": "user-1" });
      expect(await decideInbound(deps, { sender: human, isDM, conversation: THREAD, allowOnboarding: true })).toEqual({
        kind: "ignore",
        reason: "group",
      });
      expect(deps.findLinkedUser).not.toHaveBeenCalled();
    }
  });

  it("dispatches a linked sender with a principal derived from the internal user, not the handle", async () => {
    const deps = lookup({ "+14155550100": "user-1" });
    const decision = await decideInbound(deps, {
      sender: human,
      isDM: true,
      conversation: THREAD,
      allowOnboarding: true,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") return;
    expect(deps.findLinkedUser).toHaveBeenCalledWith("+14155550100");
    expect(readPrincipal(decision.auth)).toEqual({
      userId: "user-1",
      channel: "imessage",
      conversation: THREAD,
      handle: "+14155550100",
    });
  });

  it("gives an unknown sender only a link reply, bound to the normalized handle and thread", async () => {
    const deps = lookup();
    const decision = await decideInbound(deps, {
      sender: human,
      isDM: true,
      conversation: THREAD,
      allowOnboarding: true,
    });
    expect(decision.kind).toBe("onboard");
    if (decision.kind !== "onboard") return;
    expect(deps.issueLinkToken).toHaveBeenCalledWith("+14155550100", THREAD);
    expect(decision.reply).toContain("https://pidge.test/link/imessage?token=tok_123");
  });

  it("stays silent for an unknown sender while link issuance is rate-limited", async () => {
    const deps = lookup({}, null);
    const decision = await decideInbound(deps, {
      sender: human,
      isDM: true,
      conversation: THREAD,
      allowOnboarding: true,
    });
    expect(decision).toEqual({ kind: "onboard", handle: "+14155550100", reply: null });
  });

  it("applies the same checks to Tapbacks and never onboards from one", async () => {
    const unknown = lookup();
    expect(
      (await decideInbound(unknown, { sender: human, isDM: true, conversation: THREAD, allowOnboarding: false })).kind,
    ).toBe("ignore");
    expect(unknown.issueLinkToken).not.toHaveBeenCalled();

    const linked = lookup({ "+14155550100": "user-1" });
    expect(
      (
        await decideInbound(linked, {
          sender: { ...human, isMe: true },
          isDM: true,
          conversation: THREAD,
          allowOnboarding: false,
        })
      ).kind,
    ).toBe("ignore");
    expect(
      (await decideInbound(linked, { sender: human, isDM: false, conversation: THREAD, allowOnboarding: false })).kind,
    ).toBe("ignore");
  });

  it("drops senders whose handle cannot be normalized", async () => {
    const deps = lookup();
    const decision = await decideInbound(deps, {
      sender: { ...human, userId: "not a handle" },
      isDM: true,
      conversation: THREAD,
      allowOnboarding: true,
    });
    expect(decision).toEqual({ kind: "ignore", reason: "invalid_handle" });
    expect(deps.issueLinkToken).not.toHaveBeenCalled();
  });
});
