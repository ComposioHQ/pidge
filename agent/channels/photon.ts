import type { FetchFileFunction } from "eve/channels";
import { photonIMessageChannel } from "eve/channels/photon";
import { db } from "../../db/client";
import { deliveryAllowed } from "../../db/services/conversations";
import { findLinkedUser, issueLinkToken } from "../../db/services/identity";
import { appOrigin, env } from "../../shared/environment/env";
import { withReadablePhotos } from "../lib/attachments/photos";
import { decideInbound, type IdentityLookup } from "../lib/identity/photon";
import { readPrincipal } from "../lib/identity/principal";

const identity: IdentityLookup = {
  findLinkedUser: (handle) => findLinkedUser(db(), "imessage", handle),
  issueLinkToken: (handle, conversation) =>
    issueLinkToken(db(), { channel: "imessage", normalizedHandle: handle, externalConversationId: conversation }),
  linkUrl: (token) => `${appOrigin()}/link/imessage?token=${encodeURIComponent(token)}`,
};

const photon = photonIMessageChannel({
  async credentials() {
    const { IMESSAGE_PROJECT_ID: projectId, IMESSAGE_PROJECT_SECRET: projectSecret } = env();
    return { projectId, projectSecret };
  },
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
  userName: "Pidge",
  turnPolicy: "steer",
  events: {
    // docs/decisions.md D14: a notify hand-off is cancelled in `turn.started` (agent/hooks/session-owner.ts) before any
    // model call; this posts its text verbatim. Photon has no built-in `turn.cancelled` handler, so nothing is replaced.
    // The delivery check repeats here so a hand-off whose ownership check failed (also cancelled) never posts.
    async "turn.cancelled"(_event, channel, ctx) {
      const principal = readPrincipal(ctx.session.auth.current);
      if (principal?.channel !== "imessage" || !principal.notifyText) return;
      if (!channel.thread || !(await deliveryAllowed(db(), ctx.session.id, principal.userId))) {
        console.warn("pidge.notify_suppressed", { sessionId: ctx.session.id, thread: Boolean(channel.thread) });
        return;
      }
      const sent = await channel.thread.post(principal.notifyText);
      console.info("pidge.notify_posted", { sessionId: ctx.session.id, messageId: sent.id });
    },
  },
  async onMessage(ctx, message) {
    const decision = await decideInbound(identity, {
      sender: message.author,
      isDM: ctx.thread.isDM,
      conversation: ctx.thread.id,
      allowOnboarding: true,
    });
    if (decision.kind === "dispatch") return { auth: decision.auth };
    if (decision.kind === "onboard" && decision.reply) {
      // docs/decisions.md D4: unknown senders get a deterministic link reply and never reach the model.
      await ctx.thread.post(decision.reply);
    }
    return null;
  },
  async onTapback(ctx, tapback) {
    if (!tapback.added) return null;
    const decision = await decideInbound(identity, {
      sender: tapback.author,
      isDM: ctx.thread.isDM,
      conversation: ctx.thread.id,
      allowOnboarding: false,
    });
    if (decision.kind !== "dispatch") return null;
    // eve 0.83.3 approval options are `approve` / `cancel` (docs/spike.md F3). `answer` only settles the request
    // posted in the tapped message while it is still open; anything else reaches the agent as an ordinary tapback.
    if (tapback.tapback === "like") return { auth: decision.auth, answer: "approve" };
    if (tapback.tapback === "dislike") return { auth: decision.auth, answer: "cancel" };
    return { auth: decision.auth };
  },
});

// Eve 0.83.3 exposes the compiled adapter at runtime but omits it from the public Channel type.
// Keep this extension covered by the pinned-runtime attachment test before upgrading Eve (D2).
const { adapter } = photon as typeof photon & { adapter: { fetchFile: FetchFileFunction } };
adapter.fetchFile = withReadablePhotos(adapter.fetchFile);

export default photon;
