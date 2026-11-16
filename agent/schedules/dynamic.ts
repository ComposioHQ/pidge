import { defineSchedule } from "eve/schedules";
import { db } from "../../db/client";
import photon from "../channels/photon";
import { dispatchDue } from "../lib/schedules/dispatch";

/**
 * The only authored schedule: a minute dispatcher for application-managed schedules (eve's dynamic-scheduling
 * pattern; spec §13.1). Each due occurrence becomes a turn in its originating iMessage conversation.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      dispatchDue(db(), async (run, message, auth) => {
        await to(photon, { adapterName: "imessage", threadId: run.conversation }).send(message, { auth });
      }),
    );
  },
});
