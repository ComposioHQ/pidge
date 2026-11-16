import { describe, expect, it } from "vitest";
import { signWebToken, verifyWebToken, WEB_TOKEN_TTL_SECONDS } from "../../../shared/identity/web-token";
import { authorizeWebRequest } from "./web-auth";

const SECRET = "test-secret-test-secret-test-secret-0123456789";
const ORIGIN = "https://pidge.test";

function request(path: string, bearer: string | null) {
  return { url: `${ORIGIN}${path}`, bearer };
}

describe("web chat route auth", () => {
  it("accepts a token only on the session it names, for every session route", async () => {
    const token = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" });
    for (const path of [
      "/eve/v1/session/wrun_alice",
      "/eve/v1/session/wrun_alice/stream",
      "/eve/v1/session/wrun_alice/cancel",
    ]) {
      const outcome = authorizeWebRequest(SECRET, request(path, token));
      expect(outcome.kind).toBe("accept");
      if (outcome.kind === "accept") expect(outcome.auth.principalId).toBe("alice");
    }
  });

  it("forbids using one user's token on another session", async () => {
    const token = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" });
    expect(authorizeWebRequest(SECRET, request("/eve/v1/session/wrun_bob/stream", token))).toEqual({
      kind: "forbidden",
    });
  });

  it("allows session creation only with a server-minted `new` token", async () => {
    const sessionToken = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" });
    expect(authorizeWebRequest(SECRET, request("/eve/v1/session", sessionToken))).toEqual({ kind: "forbidden" });
    const createToken = signWebToken(SECRET, { sub: "alice", sid: "new" });
    expect(authorizeWebRequest(SECRET, request("/eve/v1/session", createToken)).kind).toBe("accept");
    expect(authorizeWebRequest(SECRET, request("/eve/v1/session/new/stream", createToken)).kind).toBe("accept");
  });

  it("does not authenticate missing, tampered, wrong-secret, or expired tokens", async () => {
    const token = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" });
    const [body, mac] = token.split(".") as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ sub: "bob", sid: "wrun_alice", exp: 9_999_999_999 })).toString("base64url")}.${mac}`;
    const path = "/eve/v1/session/wrun_alice";
    expect(authorizeWebRequest(SECRET, request(path, null))).toEqual({ kind: "skip" });
    expect(authorizeWebRequest(SECRET, request(path, forged))).toEqual({ kind: "skip" });
    expect(authorizeWebRequest(SECRET, request(path, `${body}.x${mac}`))).toEqual({ kind: "skip" });
    expect(authorizeWebRequest("another-secret-another-secret-0123", request(path, token))).toEqual({ kind: "skip" });

    const issuedAt = Date.now() - (WEB_TOKEN_TTL_SECONDS + 5) * 1000;
    const stale = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" }, issuedAt);
    expect(verifyWebToken(SECRET, stale)).toBeNull();
  });

  it("does not grant access to non-session routes such as agent info", async () => {
    const token = signWebToken(SECRET, { sub: "alice", sid: "wrun_alice" });
    expect(authorizeWebRequest(SECRET, request("/eve/v1/info", token))).toEqual({ kind: "forbidden" });
  });
});
