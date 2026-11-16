import { defineDynamic, defineInstructions } from "eve/instructions";
import { db } from "../../db/client";
import { getSettings } from "../../db/services/settings";
import { readPrincipal } from "../lib/identity/principal";

/**
 * A short date line appended to history right before each incoming message. Long iMessage conversations (and their
 * compaction summaries) contain dates computed on earlier days; the system-role time line alone did not stop the
 * model from reusing yesterday's "tomorrow" (docs/mvp-verification.md, Phase 3). A user-role line next to the
 * message is what the model reads when it resolves "tomorrow".
 */
export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (!principal) return null;
      const timeZone = (await getSettings(db(), principal.userId))?.timezone ?? "UTC";
      const format = (offsetDays: number) =>
        new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-US", {
          timeZone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      const time = new Date().toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
      return defineInstructions({
        role: "user",
        content: `[Pidge date check for the next message: it is ${format(0)}, ${time} (${timeZone}). "Today" is ${format(0)}; "tomorrow" is ${format(1)}.]`,
      });
    },
  },
});
