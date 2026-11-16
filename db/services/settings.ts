import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { settings } from "../schema";

export type Role = "owner" | "member";

export async function getSettings(db: Database, userId: string) {
  const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  return row ?? null;
}

export async function updateSettings(
  db: Database,
  userId: string,
  patch: { model?: string | null; timezone?: string },
): Promise<void> {
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw new Error("Unknown time zone");
  await db
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.userId, userId));
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
