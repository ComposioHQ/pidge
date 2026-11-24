import { sql } from "drizzle-orm";
import { connect, type Database } from "../db/client";
import { settings, user } from "../db/schema";
import { TEST_DATABASE_URL } from "./urls";

let shared: { db: Database; sql: ReturnType<typeof connect>["sql"] } | undefined;

export function testDb(): Database {
  shared ??= connect(TEST_DATABASE_URL, { max: 4 });
  return shared.db;
}

/** Empties every application and auth table between tests. */
export async function resetDb(): Promise<void> {
  await testDb().execute(
    sql`truncate table memory_items, approval_guards, scheduled_runs, scheduled_jobs, browser_task_runs, browser_tasks, personal_info, action_audit, artifacts, conversation_bindings, identity_link_tokens, channel_identities, settings, account, session, verification, "user" cascade`,
  );
}

export async function makeUser(name: string, role: "owner" | "member" = "member"): Promise<string> {
  const [row] = await testDb()
    .insert(user)
    .values({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` })
    .returning({ id: user.id });
  if (!row) throw new Error("user not created");
  await testDb().insert(settings).values({ userId: row.id, role });
  return row.id;
}
