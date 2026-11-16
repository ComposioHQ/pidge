import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db/client";
import { deleteSchedule } from "../../db/services/schedules";
import { scheduleManager } from "../lib/schedules/tools";

export default defineTool({
  description: "Permanently cancel one of the person's schedules. Any run in progress stops.",
  inputSchema: z.object({ id: z.string().uuid() }),
  async execute(input, ctx) {
    const manager = scheduleManager(ctx.session.auth.current);
    if (!manager.ok) return { status: "refused", error: manager.error };
    const deleted = await deleteSchedule(db(), manager.principal.userId, input.id);
    return deleted ? { status: "cancelled" } : { status: "invalid", error: "No schedule with that ID." };
  },
});
