import { defineHook } from "eve/hooks";
import { db } from "../../db/client";
import { settleEvent } from "../../db/services/triggers";
import { readPrincipal } from "../lib/identity/principal";

export default defineHook({
  events: {
    async "turn.completed"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (principal?.channel === "imessage" && principal.triggerRunId) {
        await settleEvent(db(), principal.triggerRunId, principal.userId, "completed", ctx.session.turn.id);
      }
    },
    async "turn.failed"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (principal?.channel === "imessage" && principal.triggerRunId) {
        await settleEvent(db(), principal.triggerRunId, principal.userId, "failed", ctx.session.turn.id);
      }
    },
    async "turn.cancelled"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (principal?.channel === "imessage" && principal.triggerRunId) {
        await settleEvent(db(), principal.triggerRunId, principal.userId, "failed", ctx.session.turn.id);
      }
    },
  },
});
