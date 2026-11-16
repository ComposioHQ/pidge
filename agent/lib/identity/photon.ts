import type { SessionAuthContext } from "eve/context";
import { normalizeImessageHandle } from "../../../shared/identity/handles";
import { imessagePrincipal } from "./principal";

export type InboundSender = {
  /** Photon author handle (phone number or email). */
  userId: string;
  isBot: boolean | "unknown";
  isMe: boolean;
};

export type InboundDecision =
  | { kind: "ignore"; reason: "self" | "bot" | "group" | "invalid_handle" }
  | { kind: "onboard"; handle: string; reply: string | null }
  | { kind: "dispatch"; userId: string; auth: SessionAuthContext };

export type IdentityLookup = {
  findLinkedUser(handle: string): Promise<string | null>;
  issueLinkToken(handle: string, conversation: string): Promise<{ token: string } | null>;
  linkUrl(token: string): string;
};

export function onboardingReply(url: string): string {
  return [
    "Hi, I'm Pidge 🐦 I only work for people with a Pidge account, so your messages stay private.",
    `Link this number to your account: ${url}`,
    "The link works once and expires in 15 minutes. Text me again after you've linked.",
  ].join("\n\n");
}

/**
 * Identity and DM policy shared by inbound messages and Tapbacks (spec §7.3, §8.1; docs/decisions.md D4).
 * Order matters: self/bot and group checks run before any lookup, and an unknown sender never reaches Eve.
 * Tapbacks from unknown senders are ignored without an onboarding reply (`allowOnboarding: false`).
 */
export async function decideInbound(
  deps: IdentityLookup,
  input: { sender: InboundSender; isDM: boolean | null; conversation: string; allowOnboarding: boolean },
): Promise<InboundDecision> {
  if (input.sender.isMe) return { kind: "ignore", reason: "self" };
  if (input.sender.isBot !== false) return { kind: "ignore", reason: "bot" };
  if (input.isDM !== true) return { kind: "ignore", reason: "group" };
  const handle = normalizeImessageHandle(input.sender.userId);
  if (!handle) return { kind: "ignore", reason: "invalid_handle" };
  const userId = await deps.findLinkedUser(handle);
  if (userId) return { kind: "dispatch", userId, auth: imessagePrincipal(userId, input.conversation, handle) };
  if (!input.allowOnboarding) return { kind: "ignore", reason: "invalid_handle" };
  const issued = await deps.issueLinkToken(handle, input.conversation);
  return { kind: "onboard", handle, reply: issued ? onboardingReply(deps.linkUrl(issued.token)) : null };
}
