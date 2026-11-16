import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db/client";
import { updateSchedule } from "../../db/services/schedules";
import { cadenceSchema, describeSchedule, scheduleManager, toCadence } from "../lib/schedules/tools";

export default defineTool({
  description:
    "Change one of the person's schedules: its title, instruction, or timing, or pause (enabled: false) and resume (enabled: true) it. List schedules first if it's unclear which one they mean.",
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(120).optional(),
    instruction: z.string().min(1).max(4000).optional(),
    when: cadenceSchema.optional(),
    enabled: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const manager = scheduleManager(ctx.session.auth.current);
    if (!manager.ok) return { status: "refused", error: manager.error };
    const updated = await updateSchedule(db(), manager.principal.userId, input.id, {
      title: input.title,
      instruction: input.instruction,
      cadence: input.when ? toCadence(input.when) : undefined,
      enabled: input.enabled,
    });
    if (!updated.ok) return { status: "invalid", error: updated.error };
    return { status: "updated", schedule: describeSchedule(updated.job) };
  },
});
