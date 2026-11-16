import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db/client";
import { createSchedule } from "../../db/services/schedules";
import { cadenceSchema, describeSchedule, scheduleOrigin, toCadence } from "../lib/schedules/tools";

export default defineTool({
  description:
    "Schedule Pidge to text the person later in this conversation: once at a time, every N minutes, or on a recurring local-time cron. When it fires, Pidge follows the instruction and replies here. Use the person's local time; their timezone comes from their settings.",
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("Short label, e.g. 'Dinner details and directions'."),
    instruction: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "What to do and send when it fires, self-contained: include the concrete details needed (names, addresses, times, confirmation numbers), since the conversation may have moved on.",
      ),
    when: cadenceSchema,
  }),
  async execute(input, ctx) {
    const origin = scheduleOrigin(ctx.session.auth.current, ctx.session.id);
    if (!origin.ok) return { status: "refused", error: origin.error };
    const created = await createSchedule(db(), origin.origin, {
      title: input.title,
      instruction: input.instruction,
      cadence: toCadence(input.when),
    });
    if (!created.ok) return { status: "invalid", error: created.error };
    return { status: "scheduled", schedule: describeSchedule(created.job) };
  },
});
