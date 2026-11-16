import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { channelIdentities } from "../schema";
import {
  claimConversation,
  deliveryAllowed,
  findOwnerDeliveryTarget,
  getBinding,
  ownsConversation,
} from "./conversations";
import { listIdentities, unlinkIdentity } from "./identity";

const THREAD = "imessage:any;-;+14155550100~shared";
const HANDLE = "+14155550100";

function imessage(eveSessionId: string, userId: string, externalConversationId = THREAD) {
  return {
    eveSessionId,
    userId,
    channel: "imessage" as const,
    externalConversationId,
    deliveryHandle: HANDLE,
  };
}

describe("conversation ownership", () => {
  beforeEach(resetDb);

  it("binds a session to its first user and rejects any other user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    expect(await claimConversation(testDb(), imessage("wrun_1", alice))).toEqual({ ok: true });
    expect(await claimConversation(testDb(), imessage("wrun_1", alice))).toEqual({ ok: true });
    expect(await claimConversation(testDb(), imessage("wrun_1", bob))).toEqual({ ok: false });
    expect((await getBinding(testDb(), "wrun_1"))?.userId).toBe(alice);
    expect(await ownsConversation(testDb(), "wrun_1", bob)).toBe(false);
  });

  it("re-points a thread to a new Eve session only for the same user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await claimConversation(testDb(), imessage("wrun_old", alice));
    expect(await claimConversation(testDb(), imessage("wrun_new", bob))).toEqual({ ok: false });
    expect(await claimConversation(testDb(), imessage("wrun_new", alice))).toEqual({ ok: true });
    expect(await getBinding(testDb(), "wrun_old")).toBeNull();
    expect((await getBinding(testDb(), "wrun_new"))?.userId).toBe(alice);
  });

  it("rejects moving an existing session to another conversation", async () => {
    const alice = await makeUser("Alice");
    await claimConversation(testDb(), imessage("wrun_1", alice));
    expect(await claimConversation(testDb(), imessage("wrun_1", alice, "imessage:other"))).toEqual({ ok: false });
  });

  it("suppresses delivery once the destination handle is unlinked", async () => {
    const alice = await makeUser("Alice");
    await testDb().insert(channelIdentities).values({ userId: alice, channel: "imessage", normalizedHandle: HANDLE });
    await claimConversation(testDb(), imessage("wrun_1", alice));
    expect(await deliveryAllowed(testDb(), "wrun_1", alice)).toBe(true);

    const [identity] = await listIdentities(testDb(), alice);
    if (!identity) throw new Error("identity missing");
    await unlinkIdentity(testDb(), { userId: alice, identityId: identity.id });
    expect(await deliveryAllowed(testDb(), "wrun_1", alice)).toBe(false);
  });

  it("denies delivery for unknown sessions and for a different user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await testDb().insert(channelIdentities).values({ userId: alice, channel: "imessage", normalizedHandle: HANDLE });
    await claimConversation(testDb(), imessage("wrun_1", alice));
    expect(await deliveryAllowed(testDb(), "wrun_unknown", alice)).toBe(false);
    expect(await deliveryAllowed(testDb(), "wrun_1", bob)).toBe(false);
  });

  it("treats web conversations as owned only by their creator", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await claimConversation(testDb(), {
      eveSessionId: "wrun_web",
      userId: alice,
      channel: "web",
      externalConversationId: null,
      deliveryHandle: null,
    });
    expect(await ownsConversation(testDb(), "wrun_web", alice)).toBe(true);
    expect(await ownsConversation(testDb(), "wrun_web", bob)).toBe(false);
    expect(await deliveryAllowed(testDb(), "wrun_web", bob)).toBe(false);
  });
});

describe("owner delivery target", () => {
  beforeEach(resetDb);

  async function link(userId: string, handle = HANDLE) {
    await testDb().insert(channelIdentities).values({ userId, channel: "imessage", normalizedHandle: handle });
  }

  it("is the owner's linked iMessage conversation, never a member's or a web session", async () => {
    const owner = await makeUser("Owner", "owner");
    const member = await makeUser("Member");
    await link(member, "+14155550199");
    await claimConversation(testDb(), {
      ...imessage("wrun_member", member, "imessage:any;-;+14155550199"),
      deliveryHandle: "+14155550199",
    });
    await claimConversation(testDb(), {
      eveSessionId: "wrun_web",
      userId: owner,
      channel: "web",
      externalConversationId: null,
      deliveryHandle: null,
    });
    expect(await findOwnerDeliveryTarget(testDb())).toBeNull();

    await link(owner);
    await claimConversation(testDb(), imessage("wrun_owner", owner));
    expect(await findOwnerDeliveryTarget(testDb())).toEqual({ userId: owner, conversation: THREAD, handle: HANDLE });
  });

  it("is null once the owner's handle is unlinked", async () => {
    const owner = await makeUser("Owner", "owner");
    await link(owner);
    await claimConversation(testDb(), imessage("wrun_owner", owner));
    const [identity] = await listIdentities(testDb(), owner);
    if (!identity) throw new Error("identity missing");
    await unlinkIdentity(testDb(), { userId: owner, identityId: identity.id });
    expect(await findOwnerDeliveryTarget(testDb())).toBeNull();
  });
});
