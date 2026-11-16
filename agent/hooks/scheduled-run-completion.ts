import { defineHook } from "eve/hooks";
import { db } from "../../db/client";
import { settleScheduledRun } from "../../db/services/schedules";
import { readPrincipal } from "../lib/identity/principal";

function scheduledRun(auth: Parameters<typeof readPrincipal>[0]) {
  const principal = readPrincipal(auth);
  return principal?.channel === "imessage" && principal.scheduledRunId
    ? { runId: principal.scheduledRunId, userId: principal.userId }
    : null;
}

/**
 * Settles a scheduled run when its report turn ends (spec §13.1 delivery settlement). The final reply is the
 * delivered report; its first characters are kept as the bounded outcome shown on /schedules.
 */
export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      const run = scheduledRun(ctx.session.auth.current);
      if (!run || event.data.finishReason === "tool-calls" || !event.data.message) return;
      await settleScheduledRun(db(), run.runId, run.userId, "completed", event.data.message);
    },
    async "turn.completed"(_event, ctx) {
      const run = scheduledRun(ctx.session.auth.current);
      if (run) await settleScheduledRun(db(), run.runId, run.userId, "completed", null);
    },
    async "turn.failed"(_event, ctx) {
      const run = scheduledRun(ctx.session.auth.current);
      if (run) await settleScheduledRun(db(), run.runId, run.userId, "failed", "The report turn failed.");
    },
    async "turn.cancelled"(_event, ctx) {
      const run = scheduledRun(ctx.session.auth.current);
      if (run) {
        await settleScheduledRun(
          db(),
          run.runId,
          run.userId,
          "failed",
          "Stopped: the schedule was paused or cancelled, or the run ran out of time.",
        );
      }
    },
  },
});
