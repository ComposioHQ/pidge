/// <reference types="eve/workflow-modules" />
import { defineWorkflowTool } from "eve/tools";
import {
  closeErrand,
  type Errand,
  loadContact,
  openErrand,
  type StartResult,
  settleRun,
  startRun,
  stopRun,
  type WatchResult,
  watchRun,
} from "../lib/browser/runs";
import {
  buildTaskText,
  type CommitPhase,
  commitApprovalPrompt,
  prepareSucceeded,
  runBrowserApproval,
  runBrowserInputSchema,
} from "../lib/browser/task-text";
import { readPrincipal } from "../lib/identity/principal";

const MAX_POLLS = 60;

type Running = Extract<StartResult, { ok: true }>;

/**
 * The only model-facing browser entry point (spec §6, §11.1; Composio `browser_tool` per docs/decisions.md D5).
 * A resumable task: the first call starts an errand; a later call with the same taskId corrects it (the current
 * remote task is stopped and a new one started with the full corrected assignment). Research runs never need
 * approval; every committing run needs Eve approval of its exact terms before it can start (spec §9.6, §9.7).
 */
export default defineWorkflowTool({
  description:
    "Run a hosted browser agent for sites without a suitable app tool, e.g. checking restaurant availability or completing a guest booking. Returns a task receipt; the verified result arrives later. To change a running errand (different party size, time, place), call again with its taskId and the complete updated instructions.",
  inputSchema: runBrowserInputSchema,
  approval: {
    request: ({ toolInput }) => runBrowserApproval(toolInput),
    prompt: ({ input }) => (input.terms ? commitApprovalPrompt(input.terms) : "Approve this browser action?"),
  },
  async serve(receive, ctx) {
    "use workflow";
    let errand: Errand | undefined;
    let owner: string | undefined;
    let running: Running | undefined;
    let next = receive();

    for (;;) {
      const call = await next;
      next = receive();
      const principal = readPrincipal(ctx.session.auth.current);
      if (!principal || (owner && owner !== principal.userId)) {
        ctx.reply({ status: "refused", error: "This browser errand belongs to someone else." });
        continue;
      }
      if (principal.channel === "imessage" && (principal.scheduledRunId || principal.triggerRunId)) {
        // spec §10.3: a scheduled report continues existing context; it starts no new browser work.
        ctx.reply({ status: "refused", error: "Automated runs can't start browser errands." });
        continue;
      }
      owner = principal.userId;
      errand ??= await openErrand({
        userId: owner,
        eveSessionId: ctx.session.id,
        summary: call.input.instructions,
      });

      let input = call.input;
      let requestKey = call.callId;
      let settled: WatchResult | undefined;
      let failure: string | undefined;
      let aborted = false;
      // Committing runs: `prepare` reaches the guest form, then `complete` fills and submits it in the same browser
      // session, so each half gets the hosted agent's full step budget.
      let phase: CommitPhase = "prepare";
      let preparedSession: string | undefined;
      const abort = new Promise<"abort">((resolve) =>
        call.abortSignal.addEventListener("abort", () => resolve("abort"), { once: true }),
      );

      // Start (or restart after a correction) and poll until terminal, cancelled, or corrected again.
      for (let restart = 0; restart < 6 && !settled && !failure && !aborted; restart++) {
        if (running) {
          await stopRun({ runId: running.runId, userId: owner, superseded: true });
          running = undefined;
        }
        const completing = input.mode === "commit" && phase === "complete";
        const contact = completing ? await loadContact(owner) : null;
        const started = await startRun({
          errand,
          userId: owner,
          requestKey: completing ? `${requestKey}:complete` : requestKey,
          mode: input.mode,
          taskText: buildTaskText(input, contact, phase),
          startUrl: completing ? undefined : input.start_url,
          browserSessionId: completing ? preparedSession : undefined,
        });
        if (!started.ok) {
          failure = started.reason;
          break;
        }
        running = started;
        let corrected = false;
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          const outcome = await Promise.race([
            watchRun({ runId: started.runId, userId: owner }).then((watch) => ({ kind: "watch" as const, watch })),
            next.then((nextCall) => ({ kind: "call" as const, nextCall })),
            abort.then(() => ({ kind: "abort" as const })),
          ]);
          if (outcome.kind === "abort") {
            aborted = true;
            break;
          }
          if (outcome.kind === "call") {
            // A correction for this errand: the newest complete instructions replace the running task.
            next = receive();
            input = outcome.nextCall.input;
            requestKey = outcome.nextCall.callId;
            phase = "prepare";
            preparedSession = undefined;
            corrected = true;
            break;
          }
          if (outcome.watch.terminal) {
            settled = outcome.watch;
            break;
          }
        }
        if (settled && input.mode === "commit" && phase === "prepare" && prepareSucceeded(settled.output)) {
          // The form is on screen: record the prepare run and continue in the same browser session.
          await settleRun({ runId: running.runId, userId: owner, eveSessionId: ctx.session.id, watch: settled });
          preparedSession = running.remoteBrowserSessionId;
          running = undefined;
          settled = undefined;
          phase = "complete";
          continue;
        }
        if (!settled && !corrected && !aborted) failure = "The browser task did not finish in time.";
      }

      if (aborted) {
        if (running) await stopRun({ runId: running.runId, userId: owner, superseded: false });
        running = undefined;
        await closeErrand({ errandId: errand.errandId, userId: owner, status: "stopped" });
        continue;
      }
      if (failure || !settled || !running) {
        if (running) await stopRun({ runId: running.runId, userId: owner, superseded: false });
        running = undefined;
        await closeErrand({ errandId: errand.errandId, userId: owner, status: "failed" });
        ctx.reply({
          status: "failed",
          mode: input.mode,
          error: failure ?? "The browser task stopped without a result.",
        });
        continue;
      }
      const { artifacts } = await settleRun({
        runId: running.runId,
        userId: owner,
        eveSessionId: ctx.session.id,
        watch: settled,
      });
      running = undefined;
      ctx.reply({
        status: settled.status,
        mode: input.mode,
        success: settled.success,
        result: settled.output,
        final_url: settled.currentUrl,
        artifacts,
        note:
          input.mode === "research"
            ? "Research only: nothing was submitted. Report only what the result shows."
            : phase === "prepare"
              ? "The booking form was not reached, so nothing was submitted. Say what blocked it."
              : "Report the confirmation exactly as shown; if it is missing or differs from the approved terms, say so.",
      });
    }
  },
});
