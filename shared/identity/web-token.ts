import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Short-lived bearer tokens that let a signed-in browser reach exactly one Eve session over `/eve/v1/*`.
 * Minted by the Next.js server only after it verifies the Better Auth session and the conversation binding;
 * verified by the agent's HTTP channel, which also checks the request path names the same session (spec §7.4).
 * Consumed by both the web app and the agent, hence `shared/`.
 */
export type WebTokenClaims = {
  /** Internal user UUID. */
  sub: string;
  /** Eve session the token is scoped to. */
  sid: string;
  /** Expiry, seconds since epoch. */
  exp: number;
};

export const WEB_TOKEN_TTL_SECONDS = 10 * 60;

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "pidge", "eve-web-session-token/v1", 32));
}

export function signWebToken(secret: string, claims: { sub: string; sid: string }, nowMs = Date.now()): string {
  const payload: WebTokenClaims = { ...claims, exp: Math.floor(nowMs / 1000) + WEB_TOKEN_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key(secret)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyWebToken(secret: string, token: string, nowMs = Date.now()): WebTokenClaims | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", key(secret)).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof (claims as WebTokenClaims).sub !== "string" ||
    typeof (claims as WebTokenClaims).sid !== "string" ||
    typeof (claims as WebTokenClaims).exp !== "number"
  ) {
    return null;
  }
  const typed = claims as WebTokenClaims;
  return typed.exp * 1000 > nowMs ? typed : null;
}

/** Eve session ID targeted by an `/eve/v1/session/:id/...` request; `null` for session creation or other routes. */
export function sessionIdFromPath(pathname: string): {
  route: "create" | "session" | "other";
  sessionId: string | null;
} {
  const match = /\/eve\/v1\/session(?:\/([^/]+))?(?:\/[^/]*)?$/.exec(pathname);
  if (!match) return { route: "other", sessionId: null };
  if (!match[1]) return { route: "create", sessionId: null };
  return { route: "session", sessionId: decodeURIComponent(match[1]) };
}
