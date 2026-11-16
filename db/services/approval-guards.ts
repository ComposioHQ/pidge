import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { approvalGuards } from "../schema";

export type GuardInput = { callId: string; userId: string; eveSessionId: string; bootId: string };

/** Records the process that parked an approval. The first record wins; a re-evaluation never moves it. */
export async function parkApproval(db: Database, input: GuardInput): Promise<void> {
  await db
    .insert(approvalGuards)
    .values({ ...input, status: "parked" })
    .onConflictDoNothing();
}

export type GuardDecision = { ok: true } | { ok: false; reason: "missing" | "restarted" | "already_started" };

/**
 * Claims the single execution of an approved call (spec §9.6). Fails closed when the approval was parked by a
 * process that is gone (restart while waiting), when the call already started once (a step re-run after a crash
 * mid-request), or when there is no record that approval was requested for this user and conversation.
 */
export async function claimApprovedExecution(db: Database, input: GuardInput): Promise<GuardDecision> {
  const [row] = await db
    .select()
    .from(approvalGuards)
    .where(
      and(
        eq(approvalGuards.callId, input.callId),
        eq(approvalGuards.userId, input.userId),
        eq(approvalGuards.eveSessionId, input.eveSessionId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };
  if (row.status === "started") return { ok: false, reason: "already_started" };
  if (row.bootId !== input.bootId) return { ok: false, reason: "restarted" };
  const claimed = await db
    .update(approvalGuards)
    .set({ status: "started", updatedAt: new Date() })
    .where(and(eq(approvalGuards.callId, input.callId), eq(approvalGuards.status, "parked")))
    .returning({ callId: approvalGuards.callId });
  return claimed.length > 0 ? { ok: true } : { ok: false, reason: "already_started" };
}
