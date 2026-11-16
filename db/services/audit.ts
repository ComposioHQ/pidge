import { desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { actionAudit } from "../schema";

export type AuditEntry = {
  userId: string;
  eveSessionId: string;
  toolSlug: string;
  risk: string;
  approval: "required" | "not_required";
  outcome: "completed" | "failed" | "blocked" | "denied" | "error";
  composioLogId: string | null;
};

/** Records metadata only. Callers must never pass arguments, results, or links (spec §14, §17.2). */
export async function recordActions(db: Database, entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(actionAudit).values(entries);
}

export async function listRecentActions(db: Database, userId: string, limit = 50) {
  return db
    .select({
      toolSlug: actionAudit.toolSlug,
      risk: actionAudit.risk,
      approval: actionAudit.approval,
      outcome: actionAudit.outcome,
      createdAt: actionAudit.createdAt,
    })
    .from(actionAudit)
    .where(eq(actionAudit.userId, userId))
    .orderBy(desc(actionAudit.createdAt))
    .limit(limit);
}
