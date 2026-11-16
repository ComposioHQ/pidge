import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db/client";
import { browserTaskRuns, browserTasks, personalInfo } from "../../../db/schema";
import { storeArtifact } from "../../../db/services/artifacts";
import { appOrigin, env } from "../../../shared/environment/env";
import { composioAdmin } from "../composio/client";
import type { Contact } from "./task-text";

/**
 * Durable `run_browser` steps over Composio's `browser_tool` (docs/decisions.md D5). Every remote call is preceded by
 * an ownership check against `browser_task_runs` (spike F7: the provider does not check task ownership), and a start
 * is idempotent per request key so a replayed step never creates a second remote task (spec §11.1).
 */

const MAX_OUTPUT_CHARS = 4000;
const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function browserSessionConfig() {
  return {
    sessionPreset: "direct_tools" as const,
    toolkits: { enable: ["browser_tool"] },
    manageConnections: false,
    sandbox: { enable: false },
    proxyExecute: false,
    instant: { toolkits: { enable: ["browser_tool"] }, returnInstantCharge: true },
  };
}

async function execute(composioSessionId: string, slug: string, args: Record<string, unknown>) {
  const session = await composioAdmin().use(composioSessionId);
  return session.execute(slug, args);
}

const createTaskData = z.object({ watch_task_id: z.string(), browser_session_id: z.string() });
const watchData = z
  .object({
    status: z.string(),
    output: z.unknown().optional(),
    isSuccess: z.boolean().nullable().optional(),
    current_step: z.number().optional(),
    current_url: z.string().nullable().optional(),
    outputFiles: z
      .array(z.object({ id: z.string(), fileName: z.string().optional(), name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
const outputFileData = z.object({ url: z.string().url() }).passthrough();

export const TERMINAL = new Set(["finished", "completed", "failed", "stopped", "cancelled", "error"]);

export type Errand = { errandId: string; composioSessionId: string };

/** Creates the errand row and a user-scoped Composio session restricted to `browser_tool`. */
export async function openErrand(input: { userId: string; eveSessionId: string; summary: string }): Promise<Errand> {
  const session = await composioAdmin().create(input.userId, browserSessionConfig());
  const [row] = await db()
    .insert(browserTasks)
    .values({
      userId: input.userId,
      eveSessionId: input.eveSessionId,
      composioSessionId: session.sessionId,
      status: "running",
      summary: input.summary.slice(0, 300),
    })
    .returning({ id: browserTasks.id });
  if (!row) throw new Error("errand not created");
  return { errandId: row.id, composioSessionId: session.sessionId };
}

/** Contact fields for committing runs only (spec §12: only non-secret fields the assignment needs). */
export async function loadContact(userId: string): Promise<Contact | null> {
  const [row] = await db().select().from(personalInfo).where(eq(personalInfo.userId, userId)).limit(1);
  return row ? { fullName: row.fullName, email: row.email, phone: row.phone } : null;
}

export type StartResult =
  | { ok: true; runId: string; remoteTaskId: string; remoteBrowserSessionId: string }
  | { ok: false; reason: string };

/**
 * Starts one remote task. Idempotent per `requestKey`: if a previous attempt already recorded a remote task it is
 * reused; if it started but never recorded an ID, the outcome is ambiguous and nothing is re-sent (spec §11.1).
 */
export async function startRun(input: {
  errand: Errand;
  userId: string;
  requestKey: string;
  mode: "research" | "commit";
  taskText: string;
  startUrl?: string;
  browserSessionId?: string;
}): Promise<StartResult> {
  const inserted = await db()
    .insert(browserTaskRuns)
    .values({
      browserTaskId: input.errand.errandId,
      userId: input.userId,
      requestKey: input.requestKey,
      mode: input.mode,
      status: "starting",
    })
    .onConflictDoNothing()
    .returning({ id: browserTaskRuns.id });
  if (!inserted[0]) {
    const [existing] = await db()
      .select()
      .from(browserTaskRuns)
      .where(and(eq(browserTaskRuns.requestKey, input.requestKey), eq(browserTaskRuns.userId, input.userId)))
      .limit(1);
    if (existing?.remoteTaskId && existing.remoteBrowserSessionId) {
      return {
        ok: true,
        runId: existing.id,
        remoteTaskId: existing.remoteTaskId,
        remoteBrowserSessionId: existing.remoteBrowserSessionId,
      };
    }
    if (existing)
      await db().update(browserTaskRuns).set({ status: "ambiguous" }).where(eq(browserTaskRuns.id, existing.id));
    return { ok: false, reason: "An earlier start attempt had an unknown outcome; it was not repeated." };
  }
  const runId = inserted[0].id;
  try {
    const response = await execute(input.errand.composioSessionId, "BROWSER_TOOL_CREATE_TASK", {
      task: input.taskText,
      ...(input.startUrl ? { startUrl: input.startUrl } : {}),
      ...(input.browserSessionId ? { sessionId: input.browserSessionId } : {}),
    });
    const data = createTaskData.safeParse(response.data);
    if (response.resultType !== "completed" || !data.success) {
      await db()
        .update(browserTaskRuns)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(browserTaskRuns.id, runId));
      return { ok: false, reason: response.error ?? "The browser task could not start." };
    }
    await db()
      .update(browserTaskRuns)
      .set({
        status: "running",
        remoteTaskId: data.data.watch_task_id,
        remoteBrowserSessionId: data.data.browser_session_id,
        instantCharge: response.instantCharge === undefined ? null : JSON.stringify(response.instantCharge),
        updatedAt: new Date(),
      })
      .where(eq(browserTaskRuns.id, runId));
    return {
      ok: true,
      runId,
      remoteTaskId: data.data.watch_task_id,
      remoteBrowserSessionId: data.data.browser_session_id,
    };
  } catch (error) {
    // A transport failure after the request left this process is ambiguous: record it and never auto-retry.
    await db()
      .update(browserTaskRuns)
      .set({ status: "ambiguous", updatedAt: new Date() })
      .where(eq(browserTaskRuns.id, runId));
    return { ok: false, reason: `The browser task start had an unknown outcome (${String(error).slice(0, 120)}).` };
  }
}

async function ownedRun(runId: string, userId: string) {
  const [row] = await db()
    .select({ run: browserTaskRuns, composioSessionId: browserTasks.composioSessionId })
    .from(browserTaskRuns)
    .innerJoin(browserTasks, eq(browserTasks.id, browserTaskRuns.browserTaskId))
    .where(and(eq(browserTaskRuns.id, runId), eq(browserTaskRuns.userId, userId), eq(browserTasks.userId, userId)))
    .limit(1);
  if (!row?.run.remoteTaskId || !row.composioSessionId) throw new Error("Browser run not found for this user.");
  return { ...row.run, remoteTaskId: row.run.remoteTaskId, composioSessionId: row.composioSessionId };
}

export type WatchResult = {
  status: string;
  terminal: boolean;
  output: string | null;
  success: boolean | null;
  currentUrl: string | null;
  files: { id: string; name: string }[];
};

/** One `WATCH_TASK` poll (the provider waits up to ~30 s for progress). Read-only; safe to retry. */
export async function watchRun(input: { runId: string; userId: string }): Promise<WatchResult> {
  const run = await ownedRun(input.runId, input.userId);
  const response = await execute(run.composioSessionId, "BROWSER_TOOL_WATCH_TASK", { taskId: run.remoteTaskId });
  const data = watchData.safeParse(response.data);
  if (response.resultType !== "completed" || !data.success) {
    return { status: "unknown", terminal: false, output: null, success: null, currentUrl: null, files: [] };
  }
  const status = data.data.status.toLowerCase();
  const output = data.data.output === undefined || data.data.output === null ? null : String(data.data.output);
  return {
    status,
    terminal: TERMINAL.has(status),
    output: output ? output.slice(0, MAX_OUTPUT_CHARS) : null,
    success: data.data.isSuccess ?? null,
    currentUrl: data.data.current_url ?? null,
    files: (data.data.outputFiles ?? []).slice(0, MAX_ARTIFACTS).map((file) => ({
      id: file.id,
      name: file.fileName ?? file.name ?? "output",
    })),
  };
}

/** Stops a run the user owns; `superseded` marks a correction rather than a cancellation. */
export async function stopRun(input: { runId: string; userId: string; superseded: boolean }): Promise<void> {
  const run = await ownedRun(input.runId, input.userId);
  if (run.status === "running" || run.status === "starting") {
    await execute(run.composioSessionId, "BROWSER_TOOL_STOP_TASK", { taskId: run.remoteTaskId });
  }
  await db()
    .update(browserTaskRuns)
    .set({ status: input.superseded ? "superseded" : "stopped", updatedAt: new Date() })
    .where(eq(browserTaskRuns.id, run.id));
}

/** Records a run's terminal state, imports its output files as private artifacts, and updates the errand. */
export async function settleRun(input: {
  runId: string;
  userId: string;
  eveSessionId: string;
  watch: WatchResult;
}): Promise<{ artifacts: { name: string; url: string }[] }> {
  const run = await ownedRun(input.runId, input.userId);
  const finalStatus = input.watch.status === "finished" || input.watch.status === "completed" ? "finished" : "failed";
  await db()
    .update(browserTaskRuns)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(browserTaskRuns.id, run.id));
  await db()
    .update(browserTasks)
    .set({
      status: finalStatus === "finished" ? "completed" : "failed",
      outcome: input.watch.output?.slice(0, 2000) ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(browserTasks.id, run.browserTaskId), eq(browserTasks.userId, input.userId)));

  const imported: { name: string; url: string }[] = [];
  for (const file of input.watch.files) {
    try {
      const response = await execute(run.composioSessionId, "BROWSER_TOOL_GET_OUTPUT_FILE", {
        taskId: run.remoteTaskId,
        fileId: file.id,
      });
      const data = outputFileData.safeParse(response.data);
      if (response.resultType !== "completed" || !data.success || !data.data.url.startsWith("https://")) continue;
      // The download URL is short-lived input, never a permanent link (spec §11.4).
      const download = await fetch(data.data.url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!download.ok) continue;
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) continue;
      const { id } = await storeArtifact(db(), env().ARTIFACT_STORAGE_DIR, {
        userId: input.userId,
        eveSessionId: input.eveSessionId,
        browserTaskId: run.browserTaskId,
        filename: file.name,
        mimeType: download.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
        bytes,
      });
      imported.push({ name: file.name, url: `${appOrigin()}/artifacts/${id}` });
    } catch (error) {
      console.warn("pidge.browser.artifact_import_failed", { error: String(error).slice(0, 160) });
    }
  }
  return { artifacts: imported };
}

/** Marks the errand stopped after a cancellation. */
export async function closeErrand(input: { errandId: string; userId: string; status: "stopped" | "failed" }) {
  await db()
    .update(browserTasks)
    .set({ status: input.status, updatedAt: new Date() })
    .where(and(eq(browserTasks.id, input.errandId), eq(browserTasks.userId, input.userId)));
}
