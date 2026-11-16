import { defineHook } from "eve/hooks";
import { db } from "../../db/client";
import { claimConversation, deliveryAllowed, ownsConversation } from "../../db/services/conversations";
import { markReporting, scheduledRunActive } from "../../db/services/schedules";
import { readPrincipal } from "../lib/identity/principal";

/**
 * Session ownership enforcement (spec §7.4, §7.3):
 * - every turn must carry a Pidge principal; the first iMessage turn binds the Eve session to that user and thread,
 *   web sessions are bound by the server before their first message;
 * - a turn whose principal differs from the stored owner is cancelled before the model runs;
 * - before every model call the destination must still be linked to the owner, so unlinking stops further work and
 *   replies for that conversation;
 * - a scheduled report turn runs only while its run's lease is live and its schedule is still enabled, checked when
 *   the turn starts and before every model call (spec §13.1);
 * - a notify hand-off (docs/decisions.md D14) is cancelled right after the ownership check, so no model call runs;
 *   the Photon channel's `turn.cancelled` handler then posts its text verbatim.
 */
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (!principal) {
        ctx.cancel();
        return;
      }
      const owned =
        principal.channel === "imessage"
          ? (
              await claimConversation(db(), {
                eveSessionId: ctx.session.id,
                userId: principal.userId,
                channel: "imessage",
                externalConversationId: principal.conversation,
                deliveryHandle: principal.handle,
              })
            ).ok
          : await ownsConversation(db(), ctx.session.id, principal.userId);
      if (!owned) {
        console.warn("pidge.session_owner_mismatch", { sessionId: ctx.session.id, channel: principal.channel });
        ctx.cancel();
        return;
      }
      if (principal.channel === "imessage" && principal.notifyText) {
        ctx.cancel();
        return;
      }
      if (principal.channel === "imessage" && principal.scheduledRunId) {
        if (!(await markReporting(db(), principal.scheduledRunId, principal.userId))) ctx.cancel();
      }
    },
    async "step.started"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (!principal || !(await deliveryAllowed(db(), ctx.session.id, principal.userId))) {
        console.warn("pidge.delivery_revoked", { sessionId: ctx.session.id });
        ctx.cancel();
        return;
      }
      if (principal.channel === "imessage" && principal.scheduledRunId) {
        if (!(await scheduledRunActive(db(), principal.scheduledRunId, principal.userId))) {
          console.warn("pidge.scheduled_run_inactive", { runId: principal.scheduledRunId });
          ctx.cancel();
        }
      }
    },
  },
});
