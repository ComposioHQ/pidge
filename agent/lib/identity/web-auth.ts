import type { SessionAuthContext } from "eve/context";
import { sessionIdFromPath, verifyWebToken } from "../../../shared/identity/web-token";
import { webPrincipal } from "./principal";

export type WebAuthOutcome = { kind: "skip" } | { kind: "forbidden" } | { kind: "accept"; auth: SessionAuthContext };

/**
 * Web chat route auth (spec §7.2, §7.4, §15.2). The Next.js server mints a short-lived token only after checking the
 * Better Auth session and the conversation binding; the token names one Eve session. Every `/eve/v1/session/:id/*`
 * request must carry a token for that exact session, so a user can never read or drive another user's session.
 * Session creation requires a token minted for `sid: "new"`, which only the server-side create action requests.
 */
export function authorizeWebRequest(secret: string, request: { url: string; bearer: string | null }): WebAuthOutcome {
  if (!request.bearer) return { kind: "skip" };
  const claims = verifyWebToken(secret, request.bearer);
  if (!claims) return { kind: "skip" };
  const target = sessionIdFromPath(new URL(request.url).pathname);
  const allowed =
    (target.route === "create" && claims.sid === "new") ||
    (target.route === "session" && target.sessionId === claims.sid);
  return allowed ? { kind: "accept", auth: webPrincipal(claims.sub) } : { kind: "forbidden" };
}
