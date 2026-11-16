import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../client";
import { personalInfo } from "../schema";

/** Non-secret contact fields only; anything secret-looking is rejected rather than stored (spec §12). */
export const personalInfoInput = z.object({
  fullName: z.string().trim().max(120).optional(),
  email: z.union([z.literal(""), z.string().trim().email().max(200)]).optional(),
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+\d\s().-]*$/, "Phone numbers may contain digits, spaces, +, (, ), . and - only.")
    .optional(),
  homeArea: z.string().trim().max(120).optional(),
});

const orNull = (value: string | undefined) => (value === undefined || value === "" ? null : value);

export async function getPersonalInfo(db: Database, userId: string) {
  const [row] = await db.select().from(personalInfo).where(eq(personalInfo.userId, userId)).limit(1);
  return row ?? null;
}

export async function savePersonalInfo(db: Database, userId: string, raw: unknown): Promise<void> {
  const input = personalInfoInput.parse(raw);
  const values = {
    fullName: orNull(input.fullName),
    email: orNull(input.email),
    phone: orNull(input.phone),
    homeArea: orNull(input.homeArea),
    updatedAt: new Date(),
  };
  await db
    .insert(personalInfo)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: personalInfo.userId, set: values });
}
