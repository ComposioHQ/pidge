import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { channelIdentities, conversationBindings, settings } from "../schema";

export type ConversationChannel = "imessage" | "web";

export type ClaimInput = {
  eveSessionId: string;
  userId: string;
  channel: ConversationChannel;
  externalConversationId: string | null;
  deliveryHandle: string | null;
};

/**
 * Binds an Eve session to exactly one internal user (spec §7.4). Re-binding the same session to the same user is a
 * no-op; any attempt by a different user, or to move a conversation to another user, fails closed. When an external
 * conversation (an iMessage thread) gets a new Eve session after the old one ended, the existing binding for that
 * thread is re-pointed only if it belongs to the same user.
 */
export async function claimConversation(db: Database, input: ClaimInput): Promise<{ ok: boolean }> {
  return db.transaction(async (tx) => {
    const [bySession] = await tx
      .select()
      .from(conversationBindings)
      .where(eq(conversationBindings.eveSessionId, input.eveSessionId))
      .for("update")
      .limit(1);
    if (bySession) {
      const same =
        bySession.userId === input.userId &&
        bySession.channel === input.channel &&
        bySession.externalConversationId === input.externalConversationId;
      return { ok: same };
    }
    if (input.externalConversationId) {
      const [byThread] = await tx
        .select()
        .from(conversationBindings)
        .where(
          and(
            eq(conversationBindings.channel, input.channel),
            eq(conversationBindings.externalConversationId, input.externalConversationId),
          ),
        )
        .for("update")
        .limit(1);
      if (byThread) {
        if (byThread.userId !== input.userId) return { ok: false };
        await tx
          .update(conversationBindings)
          .set({ eveSessionId: input.eveSessionId, deliveryHandle: input.deliveryHandle, updatedAt: new Date() })
          .where(eq(conversationBindings.id, byThread.id));
        return { ok: true };
      }
    }
    const inserted = await tx
      .insert(conversationBindings)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: conversationBindings.id });
    return { ok: inserted.length > 0 };
  });
}

export async function getBinding(db: Database, eveSessionId: string) {
  const [row] = await db
    .select()
    .from(conversationBindings)
    .where(eq(conversationBindings.eveSessionId, eveSessionId))
    .limit(1);
  return row ?? null;
}

/** True only when the Eve session belongs to `userId`. */
export async function ownsConversation(db: Database, eveSessionId: string, userId: string): Promise<boolean> {
  const row = await getBinding(db, eveSessionId);
  return row?.userId === userId;
}

/**
 * Immediately-before-dispatch delivery check (spec §7.3): the conversation must still belong to the user and, for
 * iMessage, the destination handle must still be linked to that same user.
 */
export async function deliveryAllowed(db: Database, eveSessionId: string, userId: string): Promise<boolean> {
  const row = await getBinding(db, eveSessionId);
  if (!row || row.userId !== userId) return false;
  if (row.channel === "web") return true;
  if (!row.deliveryHandle) return false;
  const [identity] = await db
    .select({ id: channelIdentities.id })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, row.channel),
        eq(channelIdentities.normalizedHandle, row.deliveryHandle),
        eq(channelIdentities.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(identity);
}

export async function listConversations(db: Database, userId: string) {
  return db
    .select({
      eveSessionId: conversationBindings.eveSessionId,
      channel: conversationBindings.channel,
      title: conversationBindings.title,
      updatedAt: conversationBindings.updatedAt,
    })
    .from(conversationBindings)
    .where(eq(conversationBindings.userId, userId))
    .orderBy(desc(conversationBindings.updatedAt));
}

/**
 * The owner's most recently active iMessage conversation whose delivery handle is still linked to the owner, for
 * notify hand-offs (docs/decisions.md D14). Null when there is no owner or no deliverable conversation.
 */
export async function findOwnerDeliveryTarget(
  db: Database,
): Promise<{ userId: string; conversation: string; handle: string } | null> {
  const [row] = await db
    .select({
      userId: conversationBindings.userId,
      conversation: conversationBindings.externalConversationId,
      handle: conversationBindings.deliveryHandle,
    })
    .from(conversationBindings)
    .innerJoin(settings, and(eq(settings.userId, conversationBindings.userId), eq(settings.role, "owner")))
    .innerJoin(
      channelIdentities,
      and(
        eq(channelIdentities.channel, conversationBindings.channel),
        eq(channelIdentities.normalizedHandle, conversationBindings.deliveryHandle),
        eq(channelIdentities.userId, conversationBindings.userId),
      ),
    )
    .where(eq(conversationBindings.channel, "imessage"))
    .orderBy(desc(conversationBindings.updatedAt))
    .limit(1);
  if (!row?.conversation || !row.handle) return null;
  return { userId: row.userId, conversation: row.conversation, handle: row.handle };
}
