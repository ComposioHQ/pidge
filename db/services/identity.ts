import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { channelIdentities, conversationBindings, identityLinkTokens } from "../schema";

export const LINK_TOKEN_TTL_MS = 15 * 60_000;
/** Minimum spacing between link replies to the same unknown handle, so strangers cannot flood the line. */
export const LINK_REPLY_COOLDOWN_MS = 60_000;

export type Channel = "imessage";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function findLinkedUser(db: Database, channel: Channel, normalizedHandle: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: channelIdentities.userId })
    .from(channelIdentities)
    .where(and(eq(channelIdentities.channel, channel), eq(channelIdentities.normalizedHandle, normalizedHandle)))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Issues a single-use link token bound to the sender handle and conversation, unless one was issued for the
 * same handle within the cooldown. Returns the raw token (never stored) or null when rate-limited.
 */
export async function issueLinkToken(
  db: Database,
  input: { channel: Channel; normalizedHandle: string; externalConversationId: string; now?: Date },
): Promise<{ token: string; expiresAt: Date } | null> {
  const now = input.now ?? new Date();
  const [recent] = await db
    .select({ createdAt: identityLinkTokens.createdAt })
    .from(identityLinkTokens)
    .where(
      and(
        eq(identityLinkTokens.channel, input.channel),
        eq(identityLinkTokens.normalizedHandle, input.normalizedHandle),
        gt(identityLinkTokens.createdAt, new Date(now.getTime() - LINK_REPLY_COOLDOWN_MS)),
      ),
    )
    .orderBy(desc(identityLinkTokens.createdAt))
    .limit(1);
  if (recent) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
  await db.insert(identityLinkTokens).values({
    tokenHash: hashToken(token),
    channel: input.channel,
    normalizedHandle: input.normalizedHandle,
    externalConversationId: input.externalConversationId,
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt };
}

export type ConsumeResult =
  | { ok: true; channel: Channel; normalizedHandle: string }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "already_bound" | "conversation_mismatch" };

/**
 * Consumes a link token for an authenticated user and binds the handle, atomically.
 * Unknown, expired, consumed, already-bound, or conversation-mismatched tokens fail closed (spec §7.3).
 */
export async function consumeLinkToken(
  db: Database,
  input: { token: string; userId: string; now?: Date },
): Promise<ConsumeResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(identityLinkTokens)
      .where(eq(identityLinkTokens.tokenHash, hashToken(input.token)))
      .for("update")
      .limit(1);
    if (!row) return { ok: false, reason: "invalid" } as const;
    if (row.consumedAt) return { ok: false, reason: "consumed" } as const;
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" } as const;

    const [bound] = await tx
      .select({ id: channelIdentities.id })
      .from(channelIdentities)
      .where(
        and(eq(channelIdentities.channel, row.channel), eq(channelIdentities.normalizedHandle, row.normalizedHandle)),
      )
      .limit(1);
    if (bound) return { ok: false, reason: "already_bound" } as const;

    const [conversation] = await tx
      .select({ userId: conversationBindings.userId })
      .from(conversationBindings)
      .where(
        and(
          eq(conversationBindings.channel, row.channel),
          eq(conversationBindings.externalConversationId, row.externalConversationId),
        ),
      )
      .limit(1);
    if (conversation && conversation.userId !== input.userId) {
      return { ok: false, reason: "conversation_mismatch" } as const;
    }

    // The unique (channel, handle) index settles a concurrent link race: the loser inserts nothing and fails closed.
    const inserted = await tx
      .insert(channelIdentities)
      .values({ userId: input.userId, channel: row.channel, normalizedHandle: row.normalizedHandle, verifiedAt: now })
      .onConflictDoNothing()
      .returning({ id: channelIdentities.id });
    if (inserted.length === 0) return { ok: false, reason: "already_bound" } as const;
    await tx
      .update(identityLinkTokens)
      .set({ consumedAt: now, consumedBy: input.userId })
      .where(and(eq(identityLinkTokens.id, row.id), isNull(identityLinkTokens.consumedAt)));
    return { ok: true, channel: row.channel, normalizedHandle: row.normalizedHandle } as const;
  });
}

export async function listIdentities(db: Database, userId: string) {
  return db
    .select({
      id: channelIdentities.id,
      channel: channelIdentities.channel,
      normalizedHandle: channelIdentities.normalizedHandle,
      verifiedAt: channelIdentities.verifiedAt,
    })
    .from(channelIdentities)
    .where(eq(channelIdentities.userId, userId))
    .orderBy(channelIdentities.verifiedAt);
}

/** Unlinks one of the user's own identities. Never touches the account or app connections (spec §7.3). */
export async function unlinkIdentity(db: Database, input: { userId: string; identityId: string }): Promise<boolean> {
  const deleted = await db
    .delete(channelIdentities)
    .where(and(eq(channelIdentities.id, input.identityId), eq(channelIdentities.userId, input.userId)))
    .returning({ id: channelIdentities.id });
  return deleted.length > 0;
}
