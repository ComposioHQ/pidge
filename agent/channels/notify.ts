import { defineChannel, POST } from "eve/channels";
import { db } from "../../db/client";
import { findOwnerDeliveryTarget } from "../../db/services/conversations";
import { env } from "../../shared/environment/env";
import { notifyPrincipal } from "../lib/identity/principal";
import { createKeyMemory, handleNotify, notifyTurnMessage } from "../lib/notify/request";
import photon from "./photon";

const keys = createKeyMemory();

/**
 * Owner notifications from one trusted caller (docs/decisions.md D14). Served at `/eve/v1/notify`; the Next.js app
 * exposes it as `POST /api/notify`. The text goes to the owner's iMessage conversation through eve's own proactive
 * hand-off with a notify principal; the turn is cancelled before any model call and the Photon channel posts the text.
 */
export default defineChannel({
  routes: [
    POST("/eve/v1/notify", (request, { to }) =>
      handleNotify(request, {
        token: env().PIDGE_NOTIFY_TOKEN,
        keys,
        findTarget: () => findOwnerDeliveryTarget(db()),
        async send(target, text) {
          await to(photon, { adapterName: "imessage", threadId: target.conversation }).send(notifyTurnMessage(text), {
            auth: notifyPrincipal(target.userId, target.conversation, target.handle, text),
            turnPolicy: "queue",
          });
        },
      }),
    ),
  ],
});
