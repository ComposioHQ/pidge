import type { Errand, StartResult, WatchResult } from "./runs-impl";
import type { Contact } from "./task-text";

/**
 * Workflow step boundaries for `run_browser`. The workflow driver bundle may not import Node.js builtins, so each
 * step loads the implementation (database and Composio clients) lazily inside the step; that is why these use
 * dynamic imports rather than static ones.
 */
export type { Errand, StartResult, WatchResult };

export async function openErrand(input: { userId: string; eveSessionId: string; summary: string }): Promise<Errand> {
  "use step";
  return (await import("./runs-impl")).openErrand(input);
}

export async function loadContact(userId: string): Promise<Contact | null> {
  "use step";
  return (await import("./runs-impl")).loadContact(userId);
}

export async function startRun(input: Parameters<typeof import("./runs-impl").startRun>[0]): Promise<StartResult> {
  "use step";
  return (await import("./runs-impl")).startRun(input);
}

export async function watchRun(input: { runId: string; userId: string }): Promise<WatchResult> {
  "use step";
  return (await import("./runs-impl")).watchRun(input);
}

export async function stopRun(input: { runId: string; userId: string; superseded: boolean }): Promise<void> {
  "use step";
  return (await import("./runs-impl")).stopRun(input);
}

export async function settleRun(
  input: Parameters<typeof import("./runs-impl").settleRun>[0],
): Promise<{ artifacts: { name: string; url: string }[] }> {
  "use step";
  return (await import("./runs-impl")).settleRun(input);
}

export async function closeErrand(input: { errandId: string; userId: string; status: "stopped" | "failed" }) {
  "use step";
  return (await import("./runs-impl")).closeErrand(input);
}
