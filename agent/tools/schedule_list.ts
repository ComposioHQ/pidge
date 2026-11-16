import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db/client";
import { listSchedules } from "../../db/services/schedules";
import { describeSchedule, scheduleManager } from "../lib/schedules/tools";

export default defineTool({
  description: "List the person's schedules with their next run and the status of recent runs.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const manager = scheduleManager(ctx.session.auth.current);
    if (!manager.ok) return { status: "refused", error: manager.error };
    const jobs = await listSchedules(db(), manager.principal.userId);
    return {
      schedules: jobs.map((job) => ({
        ...describeSchedule(job),
        recent_runs: job.runs.slice(0, 3).map((run) => ({ status: run.status, outcome: run.outcome })),
      })),
    };
  },
});
