import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { channelIdentities, conversationBindings, identityLinkTokens } from "../schema";
import {
  consumeLinkToken,
  findLinkedUser,
  hashToken,
  issueLinkToken,
  LINK_REPLY_COOLDOWN_MS,
  LINK_TOKEN_TTL_MS,
  listIdentities,
  unlinkIdentity,
} from "./identity";

const HANDLE = "+14155550100";
const THREAD = "imessage:any;-;+14155550100~shared";

async function issue(now = new Date(), handle = HANDLE, conversation = THREAD) {
  const issued = await issueLinkToken(testDb(), {
    channel: "imessage",
    normalizedHandle: handle,
    externalConversationId: conversation,
    now,
  });
  if (!issued) throw new Error("expected a token");
  return issued.token;
}

describe("iMessage identity linking", () => {
  beforeEach(resetDb);

  it("binds the handle to the signed-in user and stores only the token hash", async () => {
    const alice = await makeUser("Alice");
    const token = await issue();
    const stored = await testDb().select().from(identityLinkTokens);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    await expect(consumeLinkToken(testDb(), { token, userId: alice })).resolves.toEqual({
      ok: true,
      channel: "imessage",
      normalizedHandle: HANDLE,
    });
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBe(alice);
  });

  it("is single-use: a second consumption fails closed and links nothing new", async () => {
    const alice = await makeUser("Alice");
    const mallory = await makeUser("Mallory");
    const token = await issue();
    expect((await consumeLinkToken(testDb(), { token, userId: alice })).ok).toBe(true);
    expect(await consumeLinkToken(testDb(), { token, userId: mallory })).toEqual({ ok: false, reason: "consumed" });
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBe(alice);
  });

  it("rejects expired and unknown tokens", async () => {
    const alice = await makeUser("Alice");
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const token = await issue(issuedAt);
    const afterExpiry = new Date(issuedAt.getTime() + LINK_TOKEN_TTL_MS + 1);
    expect(await consumeLinkToken(testDb(), { token, userId: alice, now: afterExpiry })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await consumeLinkToken(testDb(), { token: "not-a-real-token", userId: alice })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBeNull();
  });

  it("refuses to bind a handle that is already linked, even to the same user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const start = new Date("2026-01-01T00:00:00Z");
    const first = await issue(start);
    const second = await issue(new Date(start.getTime() + LINK_REPLY_COOLDOWN_MS + 1));
    expect((await consumeLinkToken(testDb(), { token: first, userId: alice, now: start })).ok).toBe(true);
    expect(await consumeLinkToken(testDb(), { token: second, userId: bob, now: start })).toEqual({
      ok: false,
      reason: "already_bound",
    });
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBe(alice);
  });

  it("refuses a token whose conversation already belongs to another user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await testDb().insert(conversationBindings).values({
      userId: alice,
      eveSessionId: "wrun_alice",
      channel: "imessage",
      externalConversationId: THREAD,
      deliveryHandle: "+14155550199",
    });
    const token = await issue();
    expect(await consumeLinkToken(testDb(), { token, userId: bob })).toEqual({
      ok: false,
      reason: "conversation_mismatch",
    });
  });

  it("rate-limits link issuance per handle", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    await issue(start);
    const tooSoon = await issueLinkToken(testDb(), {
      channel: "imessage",
      normalizedHandle: HANDLE,
      externalConversationId: THREAD,
      now: new Date(start.getTime() + 1_000),
    });
    expect(tooSoon).toBeNull();
    const later = await issueLinkToken(testDb(), {
      channel: "imessage",
      normalizedHandle: HANDLE,
      externalConversationId: THREAD,
      now: new Date(start.getTime() + LINK_REPLY_COOLDOWN_MS + 1),
    });
    expect(later).not.toBeNull();
  });

  it("lets users unlink only their own identities", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const token = await issue();
    await consumeLinkToken(testDb(), { token, userId: alice });
    const [identity] = await listIdentities(testDb(), alice);
    if (!identity) throw new Error("identity missing");

    expect(await unlinkIdentity(testDb(), { userId: bob, identityId: identity.id })).toBe(false);
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBe(alice);
    expect(await unlinkIdentity(testDb(), { userId: alice, identityId: identity.id })).toBe(true);
    expect(await findLinkedUser(testDb(), "imessage", HANDLE)).toBeNull();
    expect(await testDb().select().from(channelIdentities).where(eq(channelIdentities.userId, alice))).toEqual([]);
  });
});
