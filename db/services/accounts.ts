import { eq } from "drizzle-orm";
import { type Database, db as defaultDb } from "../client";
import { settings, user } from "../schema";

/** The slice of Better Auth's context used to provision credential accounts without public sign-up. */
export type AccountProvisioner = {
  password: { hash(password: string): Promise<string> };
  internalAdapter: {
    createUser(
      input: { email: string; name: string; emailVerified: boolean },
      source: { method: string },
    ): Promise<{ id: string }>;
    linkAccount(input: { userId: string; providerId: string; accountId: string; password: string }): Promise<unknown>;
  };
};

export type CreateOwnerResult = { ok: true; userId: string } | { ok: false; reason: string };

export const MIN_PASSWORD_LENGTH = 12;

/** Creates the single `owner` account (spec §7.2). Refuses when an owner already exists. */
export async function createOwner(
  provisioner: AccountProvisioner,
  input: { email: string; name: string; password: string },
  database: Database = defaultDb(),
): Promise<CreateOwnerResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  const [existingOwner] = await database
    .select({ userId: settings.userId })
    .from(settings)
    .where(eq(settings.role, "owner"))
    .limit(1);
  if (existingOwner) return { ok: false, reason: "an owner already exists" };

  const email = input.email.trim().toLowerCase();
  const created = await provisioner.internalAdapter.createUser(
    { email, name: input.name.trim(), emailVerified: true },
    { method: "admin" },
  );
  try {
    await provisioner.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await provisioner.password.hash(input.password),
    });
    await database.insert(settings).values({ userId: created.id, role: "owner" });
  } catch (error) {
    // Never leave a credential account without a role row (e.g. a concurrent owner creation won the unique index).
    await database.delete(user).where(eq(user.id, created.id));
    return { ok: false, reason: error instanceof Error ? error.message : "owner creation failed" };
  }
  return { ok: true, userId: created.id };
}
