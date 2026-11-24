import { defineSchedule } from "eve/schedules";
import { db } from "../../db/client";
import photon from "../channels/photon";
import { dispatchDue } from "../lib/schedules/dispatch";
import { dispatchEvents } from "../lib/triggers/dispatch";

/**
 * Minute dispatcher for application schedules and the durable app-event inbox. Each occurrence becomes a turn
 * in its originating iMessage conversation; Composio events use the same proactive channel path.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      dispatchEvents(db(), async ({ subscription }, message, auth) => {
        await to(photon, { adapterName: "imessage", threadId: subscription.conversation }).send(message, {
          auth,
          turnPolicy: "queue",
        });
      }),
    );
    waitUntil(
      dispatchDue(db(), async (run, message, auth) => {
        await to(photon, { adapterName: "imessage", threadId: run.conversation }).send(message, { auth });
      }),
    );
  },
});
