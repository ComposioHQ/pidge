import "server-only";
import { Client } from "eve/client";
import { db } from "@/db/client";
import { claimConversation, ownsConversation } from "@/db/services/conversations";
import { env } from "@/shared/environment/env";
import { signWebToken } from "@/shared/identity/web-token";

/** Origin the Next.js server uses to reach its own `/eve/v1/*` routes. */
export function eveOrigin(): string {
  return env().EVE_INTERNAL_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
}

/** Creates an empty web chat session for the user and binds it before any message can reach it (spec §7.4). */
export async function createWebConversation(userId: string): Promise<string> {
  const client = new Client({
    host: eveOrigin(),
    auth: { bearer: signWebToken(env().BETTER_AUTH_SECRET, { sub: userId, sid: "new" }) },
    redirect: "error",
  });
  const { session } = await client.sessions.create();
  const sessionId = session.state.sessionId;
  const claimed = await claimConversation(db(), {
    eveSessionId: sessionId,
    userId,
    channel: "web",
    externalConversationId: null,
    deliveryHandle: null,
  });
  if (!claimed.ok) throw new Error("conversation binding failed");
  return sessionId;
}

/** Mints a browser token for one owned session, or null when the user does not own it. */
export async function webTokenFor(userId: string, sessionId: string): Promise<string | null> {
  if (!(await ownsConversation(db(), sessionId, userId))) return null;
  return signWebToken(env().BETTER_AUTH_SECRET, { sub: userId, sid: sessionId });
}
