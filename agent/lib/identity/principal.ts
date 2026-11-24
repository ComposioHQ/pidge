import type { SessionAuthContext } from "eve/context";

/** Authenticator name for every principal Pidge's own channels issue. */
export const PIDGE_AUTHENTICATOR = "pidge";

export type PidgePrincipal =
  | {
      userId: string;
      channel: "imessage";
      conversation: string;
      handle: string;
      /** Set only on turns the schedule dispatcher starts (spec §10.3 scheduled report). */
      scheduledRunId?: string;
      /** Durable app-event run, issued only by the local event dispatcher. */
      triggerRunId?: string;
      /** Set only on notify hand-offs (docs/decisions.md D14): text Pidge posts verbatim instead of running the model. */
      notifyText?: string;
    }
  | { userId: string; channel: "web" };

export function imessagePrincipal(userId: string, conversation: string, handle: string): SessionAuthContext {
  return {
    authenticator: PIDGE_AUTHENTICATOR,
    principalType: "user",
    principalId: userId,
    attributes: { channel: "imessage", conversation, handle },
  };
}

/** Principal for a scheduled report turn: the schedule creator in the originating iMessage conversation. */
export function scheduledPrincipal(
  userId: string,
  conversation: string,
  handle: string,
  scheduledRunId: string,
): SessionAuthContext {
  return {
    authenticator: PIDGE_AUTHENTICATOR,
    principalType: "user",
    principalId: userId,
    attributes: { channel: "imessage", conversation, handle, scheduledRunId },
  };
}

/** Runs app-event work as its creator, with ordinary user tools and write approvals. */
export function triggerPrincipal(
  userId: string,
  conversation: string,
  handle: string,
  triggerRunId: string,
): SessionAuthContext {
  return {
    authenticator: PIDGE_AUTHENTICATOR,
    principalType: "user",
    principalId: userId,
    attributes: { channel: "imessage", conversation, handle, triggerRunId },
  };
}

/** Principal for a notify hand-off (docs/decisions.md D14): the owner in their own iMessage conversation. */
export function notifyPrincipal(
  userId: string,
  conversation: string,
  handle: string,
  text: string,
): SessionAuthContext {
  return {
    authenticator: PIDGE_AUTHENTICATOR,
    principalType: "user",
    principalId: userId,
    attributes: { channel: "imessage", conversation, handle, notifyText: text },
  };
}

export function webPrincipal(userId: string): SessionAuthContext {
  return {
    authenticator: PIDGE_AUTHENTICATOR,
    principalType: "user",
    principalId: userId,
    attributes: { channel: "web" },
  };
}

/**
 * Reads a Pidge principal from trusted session auth. Anything not issued by Pidge's channels (missing auth, other
 * authenticators, malformed attributes) yields null so callers fail closed (spec §7.1: never a model-supplied ID).
 */
export function readPrincipal(auth: SessionAuthContext | null | undefined): PidgePrincipal | null {
  if (!auth || auth.authenticator !== PIDGE_AUTHENTICATOR || auth.principalType !== "user") return null;
  const { channel, conversation, handle, scheduledRunId, notifyText, triggerRunId } = auth.attributes;
  if (channel === "web") return { userId: auth.principalId, channel };
  if (channel === "imessage" && typeof conversation === "string" && typeof handle === "string") {
    if ([scheduledRunId, notifyText, triggerRunId].filter((value) => value !== undefined).length > 1) return null;
    if (triggerRunId !== undefined) {
      if (typeof triggerRunId !== "string" || triggerRunId.length === 0) return null;
      return { userId: auth.principalId, channel, conversation, handle, triggerRunId };
    }
    if (scheduledRunId !== undefined) {
      if (typeof scheduledRunId !== "string") return null;
      return { userId: auth.principalId, channel, conversation, handle, scheduledRunId };
    }
    if (notifyText !== undefined) {
      if (typeof notifyText !== "string" || notifyText.length === 0) return null;
      return { userId: auth.principalId, channel, conversation, handle, notifyText };
    }
    return { userId: auth.principalId, channel, conversation, handle };
  }
  return null;
}
