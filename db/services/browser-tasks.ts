import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { artifacts, browserTaskRuns, browserTasks } from "../schema";

/** The user's browser errands with their runs and private artifacts; never another user's rows. */
export async function listBrowserTasks(db: Database, userId: string, limit = 25) {
  const tasks = await db
    .select()
    .from(browserTasks)
    .where(eq(browserTasks.userId, userId))
    .orderBy(desc(browserTasks.createdAt))
    .limit(limit);
  if (tasks.length === 0) return [];
  const ids = tasks.map((task) => task.id);
  const [runs, files] = await Promise.all([
    db
      .select({
        browserTaskId: browserTaskRuns.browserTaskId,
        mode: browserTaskRuns.mode,
        status: browserTaskRuns.status,
        createdAt: browserTaskRuns.createdAt,
      })
      .from(browserTaskRuns)
      .where(and(eq(browserTaskRuns.userId, userId), inArray(browserTaskRuns.browserTaskId, ids)))
      .orderBy(browserTaskRuns.createdAt),
    db
      .select({ id: artifacts.id, browserTaskId: artifacts.browserTaskId, filename: artifacts.filename })
      .from(artifacts)
      .where(and(eq(artifacts.userId, userId), inArray(artifacts.browserTaskId, ids), eq(artifacts.ready, true))),
  ]);
  return tasks.map((task) => ({
    ...task,
    runs: runs.filter((run) => run.browserTaskId === task.id),
    artifacts: files.filter((file) => file.browserTaskId === task.id),
  }));
}
