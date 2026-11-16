import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";
import { getSettings, type Role } from "@/db/services/settings";
import { appOrigin, env } from "@/shared/environment/env";

function createAuth() {
  return betterAuth({
    appName: "Pidge",
    baseURL: env().BETTER_AUTH_URL ?? appOrigin(),
    secret: env().BETTER_AUTH_SECRET,
    trustedOrigins: [appOrigin()],
    database: drizzleAdapter(db(), { provider: "pg", schema: { user, session, account, verification } }),
    // Public sign-up is disabled (spec §7.2); accounts come only from `pnpm setup:owner` (and, in Phase 5, invites).
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    advanced: {
      database: { generateId: "uuid" },
      // The deployment sits behind one TLS proxy that sets X-Forwarded-For; rate limits key on the client address.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    plugins: [nextCookies()],
  });
}

/** The configured Better Auth instance; its type is inferred from the options above (plugins add endpoints). */
export type PidgeAuth = ReturnType<typeof createAuth>;

let instance: PidgeAuth | undefined;

export function auth(): PidgeAuth {
  instance ??= createAuth();
  return instance;
}

export type SignedInUser = { id: string; email: string; name: string; role: Role };

/** Current signed-in user with their application role, or null. Reads Better Auth's session cookie. */
export async function currentUser(requestHeaders?: Headers): Promise<SignedInUser | null> {
  const result = await auth().api.getSession({ headers: requestHeaders ?? (await headers()) });
  if (!result) return null;
  const settings = await getSettings(db(), result.user.id);
  if (!settings) return null;
  return { id: result.user.id, email: result.user.email, name: result.user.name, role: settings.role };
}

/** Server-component guard: redirects to sign-in when there is no signed-in user. */
export async function requireUser(returnTo: string): Promise<SignedInUser> {
  const signedIn = await currentUser();
  if (!signedIn) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return signedIn;
}
