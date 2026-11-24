import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database } from "../client";
import { appEventRuns as runs, appEventSubscriptions as subscriptions } from "../schema/triggers";

export type Subscription = typeof subscriptions.$inferSelect;
export type TriggerEvent = {
  triggerId: string;
  triggerSlug: string;
  connectedAccountId: string;
  userId: string;
  eventId: string;
  payload: Record<string, unknown>;
};
export const RETRY_MS = 60_000;
export const EVENT_TTL_MS = 24 * 60 * 60_000;
export const MAX_ATTEMPTS = 3;

export async function listSubscriptions(db: Database, userId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
}

export async function subscriptionFor(db: Database, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.id, id)));
  return row ?? null;
}

/** Persist before remote creation. A replayed Eve call must never repeat an uncertain remote write. */
export async function reserveSubscription(db: Database, input: typeof subscriptions.$inferInsert) {
  const [row] = await db.insert(subscriptions).values(input).onConflictDoNothing().returning();
  return row ?? null;
}

export async function activateSubscription(db: Database, id: string, triggerId: string) {
  await db
    .update(subscriptions)
    .set({ triggerId, status: "active" })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.status, "creating")));
}

export async function uncertainSubscription(db: Database, id: string) {
  await db
    .update(subscriptions)
    .set({ status: "uncertain" })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.status, "creating")));
}

/** Local stop wins even when Composio is unavailable. Pending work is discarded, never replayed on reconfiguration. */
export async function stopSubscription(db: Database, userId: string, id: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(subscriptions)
      .set({ status: "disabled" })
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ["active", "disabled"]),
        ),
      )
      .returning();
    if (!row) return null;
    await tx
      .update(runs)
      .set({ status: "suppressed", payload: null })
      .where(and(eq(runs.subscriptionId, id), inArray(runs.status, ["queued", "handing_off", "running"])));
    return row;
  });
}

export async function removedSubscription(db: Database, userId: string, id: string) {
  await db
    .update(subscriptions)
    .set({ status: "removed" })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId), eq(subscriptions.status, "disabled")));
}

/** All routing fields must agree with local ownership. Signed provider metadata alone cannot choose a principal. */
export async function ingestEvent(db: Database, event: TriggerEvent, now = new Date()) {
  return db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.triggerId, event.triggerId),
          eq(subscriptions.userId, event.userId),
          eq(subscriptions.triggerSlug, event.triggerSlug),
          eq(subscriptions.connectedAccountId, event.connectedAccountId),
          eq(subscriptions.status, "active"),
        ),
      )
      .for("update");
    if (!sub) {
      const [creating] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, event.userId),
            eq(subscriptions.connectedAccountId, event.connectedAccountId),
            eq(subscriptions.triggerSlug, event.triggerSlug),
            eq(subscriptions.status, "creating"),
          ),
        );
      // A provider may emit immediately, before create() returns its instance id. Ask it to retry after setup.
      if (creating) throw new Error("Subscription setup in progress");
      return "ignored" as const;
    }
    const inserted = await tx
      .insert(runs)
      .values({
        subscriptionId: sub.id,
        eventId: event.eventId,
        payload: event.payload,
        status: "queued",
        retryAt: now,
        expiresAt: new Date(now.getTime() + EVENT_TTL_MS),
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });
    return inserted.length ? ("accepted" as const) : ("duplicate" as const);
  });
}

export async function claimEvents(db: Database, now = new Date()) {
  return db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "failed", payload: null })
      .where(and(inArray(runs.status, ["queued", "handing_off", "running"]), lte(runs.expiresAt, now)));
    await tx
      .update(runs)
      .set({ status: "failed", payload: null })
      .where(and(eq(runs.status, "handing_off"), lte(runs.retryAt, now), eq(runs.attempts, MAX_ATTEMPTS)));
    const due = await tx
      .select({ run: runs, subscription: subscriptions })
      .from(runs)
      .innerJoin(subscriptions, eq(runs.subscriptionId, subscriptions.id))
      .where(
        and(
          inArray(runs.status, ["queued", "handing_off"]),
          lte(runs.retryAt, now),
          lt(runs.attempts, MAX_ATTEMPTS),
          eq(subscriptions.status, "active"),
        ),
      )
      .limit(20)
      .for("update", { of: runs, skipLocked: true });
    for (const { run } of due)
      await tx
        .update(runs)
        .set({ status: "handing_off", attempts: run.attempts + 1, retryAt: new Date(now.getTime() + RETRY_MS) })
        .where(eq(runs.id, run.id));
    return due;
  });
}

export type ClaimedEvent = Awaited<ReturnType<typeof claimEvents>>[number];

/** Exactly one Eve turn may cross the model boundary, even if a hand-off is delivered twice after a timeout. */
export async function startEvent(
  db: Database,
  runId: string,
  userId: string,
  sessionId: string,
  conversation: string,
  handle: string,
  turnId: string,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ run: runs, subscription: subscriptions })
      .from(runs)
      .innerJoin(subscriptions, eq(runs.subscriptionId, subscriptions.id))
      .where(
        and(
          eq(runs.id, runId),
          eq(subscriptions.userId, userId),
          eq(subscriptions.eveSessionId, sessionId),
          eq(subscriptions.conversation, conversation),
          eq(subscriptions.handle, handle),
          eq(subscriptions.status, "active"),
        ),
      )
      .for("update", { of: runs });
    if (!row || row.run.expiresAt <= new Date()) return false;
    if (row.run.status === "running" && row.run.turnId === turnId) return true;
    if (row.run.status !== "handing_off") return false;
    await tx.update(runs).set({ status: "running", turnId }).where(eq(runs.id, runId));
    return true;
  });
}

export async function eventActive(db: Database, runId: string, userId: string) {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(subscriptions, eq(runs.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(runs.id, runId),
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        eq(runs.status, "running"),
        sql`${runs.expiresAt} > now()`,
      ),
    );
  return Boolean(row);
}

export async function settleEvent(
  db: Database,
  runId: string,
  userId: string,
  status: "completed" | "failed" | "suppressed",
  turnId?: string,
) {
  await db
    .update(runs)
    .set({ status, payload: null })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, ["queued", "handing_off", "running"]),
        turnId ? eq(runs.turnId, turnId) : undefined,
        sql`${runs.subscriptionId} in (select id from app_event_subscriptions where user_id = ${userId})`,
      ),
    );
}

export async function recentEvents(db: Database, userId: string) {
  return db
    .select({
      id: runs.id,
      subscriptionId: runs.subscriptionId,
      status: runs.status,
      attempts: runs.attempts,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(subscriptions, eq(runs.subscriptionId, subscriptions.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(sql`${runs.createdAt} desc`)
    .limit(20);
}
