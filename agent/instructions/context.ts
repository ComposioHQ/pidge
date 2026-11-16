import { defineDynamic, defineInstructions } from "eve/instructions";
import { db } from "../../db/client";
import { getPersonalInfo } from "../../db/services/personal-info";
import { getSettings } from "../../db/services/settings";
import { readPrincipal } from "../lib/identity/principal";

/**
 * Per-turn trusted context: the person's local date/time (so "tomorrow" and "8 PM" resolve correctly) and which
 * non-secret personal fields exist. Contact values themselves stay out of the prompt; run_browser attaches them
 * server-side to approved bookings only (spec §12).
 */
export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (!principal) return null;
      const [settings, info] = await Promise.all([
        getSettings(db(), principal.userId),
        getPersonalInfo(db(), principal.userId),
      ]);
      const timeZone = settings?.timezone ?? "UTC";
      const now = new Date().toLocaleString("en-US", {
        timeZone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const day = (offsetDays: number) =>
        new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-US", {
          timeZone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      const onFile = [
        info?.fullName ? "name" : null,
        info?.phone ? "phone" : null,
        info?.email ? "email" : null,
      ].filter(Boolean);
      return defineInstructions({
        content: [
          `Current time for the person: ${now} (${timeZone}). Today is ${day(0)}; tomorrow is ${day(1)}.`,
          'Relative dates in earlier messages ("tomorrow", "tonight") meant the day those messages were sent. For a new request, work out dates from today; never reuse a date computed in an earlier turn.',
          info?.homeArea ? `Their home area: ${info.homeArea}.` : null,
          onFile.length > 0
            ? `Contact details on file for bookings: ${onFile.join(", ")} (attached automatically to approved bookings).`
            : "No contact details on file; bookings that need them should ask the person to add them at /personal-info.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    },
  },
});
