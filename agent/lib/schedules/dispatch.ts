import type { SessionAuthContext } from "eve/context";
import type { Database } from "../../../db/client";
import { deliveryAllowed } from "../../../db/services/conversations";
import { type ClaimedRun, claimDueRuns, markReporting, settleScheduledRun } from "../../../db/services/schedules";
import { scheduledPrincipal } from "../identity/principal";

export type SendReport = (run: ClaimedRun, message: string, auth: SessionAuthContext) => Promise<void>;

/** The scheduled turn's input: trusted local metadata plus the stored instruction the person asked for. */
export function reportMessage(run: ClaimedRun): string {
  return [
    `[Scheduled run: "${run.title}", set up earlier by this person in this conversation, due ${run.scheduledFor.toISOString()}.]`,
    "Do what it asks now and reply here with the result. Nothing is needed from them to start this.",
    "",
    `Instruction: ${run.instruction}`,
  ].join("\n");
}

/**
 * One dispatcher tick: lease due occurrences and hand each to its originating iMessage conversation as a new turn,
 * running as the schedule's creator. The destination is re-checked immediately before each send; an unlinked
 * destination is suppressed and recorded (spec §7.3). A failed hand-off keeps its lease and is retried by a later
 * tick after the lease expires, unless the turn already started (spec §13.1).
 */
export async function dispatchDue(db: Database, send: SendReport, now = new Date()): Promise<ClaimedRun[]> {
  const runs = await claimDueRuns(db, now);
  await Promise.all(
    runs.map(async (run) => {
      if (!(await deliveryAllowed(db, run.eveSessionId, run.userId))) {
        await settleScheduledRun(db, run.runId, run.userId, "suppressed", "The destination is no longer linked.");
        console.warn("pidge.schedule_delivery_suppressed", { runId: run.runId });
        return;
      }
      try {
        await send(run, reportMessage(run), scheduledPrincipal(run.userId, run.conversation, run.handle, run.runId));
        await markReporting(db, run.runId, run.userId, now);
      } catch (error) {
        console.error("pidge.schedule_dispatch_failed", {
          runId: run.runId,
          attempt: run.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return runs;
}
