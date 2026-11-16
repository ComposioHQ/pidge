import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { auth } from "../../web/auth/server";
import { settings, user } from "../schema";
import { createOwner } from "./accounts";

describe("account provisioning", () => {
  beforeEach(resetDb);

  it("creates exactly one owner who can sign in", async () => {
    const context = await auth().$context;
    const created = await createOwner(
      context,
      { email: "Owner@Example.com", name: "Owner", password: "correct horse battery" },
      testDb(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [role] = await testDb().select().from(settings).where(eq(settings.userId, created.userId));
    expect(role?.role).toBe("owner");

    const signedIn = await auth().api.signInEmail({
      body: { email: "owner@example.com", password: "correct horse battery" },
    });
    expect(signedIn.user.id).toBe(created.userId);

    const second = await createOwner(
      context,
      { email: "other@example.com", name: "Other", password: "correct horse battery" },
      testDb(),
    );
    expect(second).toEqual({ ok: false, reason: "an owner already exists" });
    expect(await testDb().select().from(user).where(eq(user.email, "other@example.com"))).toEqual([]);
  });

  it("enforces a single owner at the database level", async () => {
    await makeUser("First", "owner");
    await expect(makeUser("Second", "owner")).rejects.toThrow();
  });

  it("rejects short owner passwords", async () => {
    const result = await createOwner(
      await auth().$context,
      { email: "o@example.com", name: "O", password: "short" },
      testDb(),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects public sign-up", async () => {
    await expect(
      auth().api.signUpEmail({
        body: { email: "stranger@example.com", password: "a long enough password", name: "S" },
      }),
    ).rejects.toThrow();
    expect(await testDb().select().from(user).where(eq(user.email, "stranger@example.com"))).toEqual([]);
  });
});
