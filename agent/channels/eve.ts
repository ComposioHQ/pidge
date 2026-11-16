import { type AuthFn, extractBearerToken, ForbiddenError } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { env } from "../../shared/environment/env";
import { authorizeWebRequest } from "../lib/identity/web-auth";

const pidgeWebToken: AuthFn<Request> = async (request) => {
  const outcome = authorizeWebRequest(env().BETTER_AUTH_SECRET, {
    url: request.url,
    bearer: extractBearerToken(request.headers.get("authorization")) ?? null,
  });
  if (outcome.kind === "forbidden")
    throw new ForbiddenError({ message: "This token is not valid for that conversation." });
  return outcome.kind === "accept" ? outcome.auth : null;
};

// No anonymous, local-dev, or Vercel OIDC fallback: every web request needs a Pidge session token.
export default eveChannel({ auth: [pidgeWebToken] });
