import { Composio } from "@composio/core";
import { type EveHook, type EveNeedsApproval, EveProvider } from "@composio/experimental/eve";
import { z } from "zod";
import { db } from "../../../db/client";
import { claimApprovedExecution, parkApproval } from "../../../db/services/approval-guards";
import { type AuditEntry, recordActions } from "../../../db/services/audit";
import { env } from "../../../shared/environment/env";
import { readPrincipal } from "../identity/principal";
import {
  classifyAppTool,
  classifyComposioCall,
  isBrowserSlug,
  MULTI_EXECUTE,
  multiExecuteSlugs,
  type ToolHints,
} from "./policy";

/** Hint tags per app tool slug, fetched once per process. Read-only metadata; never credentials. */
const hintCache = new Map<string, ToolHints | null>();

async function loadHints(slugs: string[]): Promise<void> {
  const missing = [...new Set(slugs)].filter((slug) => !hintCache.has(slug) && !isBrowserSlug(slug));
  if (missing.length === 0) return;
  try {
    const tools = await composioAdmin().tools.getRawComposioTools({ tools: missing });
    for (const tool of tools) {
      const tags = tool.tags ?? [];
      hintCache.set(tool.slug.toUpperCase(), {
        readOnly: tags.includes("readOnlyHint"),
        destructive: tags.includes("destructiveHint"),
        toolkit: tool.toolkit?.slug,
      });
    }
  } catch (error) {
    console.warn("pidge.composio.hint_lookup_failed", { count: missing.length, error: String(error).slice(0, 200) });
  }
  // Slugs Composio did not describe stay unknown (null): the policy treats them as writes that need approval.
  for (const slug of missing) if (!hintCache.has(slug)) hintCache.set(slug, null);
}

const hintsFor = (slug: string) => hintCache.get(slug.toUpperCase()) ?? null;

async function decideApproval(metaSlug: string, input: unknown): Promise<boolean> {
  await loadHints(metaSlug.toUpperCase() === MULTI_EXECUTE ? multiExecuteSlugs(input) : []);
  return classifyComposioCall(metaSlug, input, hintsFor).approval;
}

/**
 * Identity of this eve process. Shared through a global so every bundled copy of this module agrees; a restart
 * gets a new one, which is how a parked approval from before the restart is recognized (spec §9.6).
 */
const BOOT_KEY = Symbol.for("pidge.composio.bootId");
function bootId(): string {
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  store[BOOT_KEY] ??= crypto.randomUUID();
  return store[BOOT_KEY];
}

// The provider types `needsApproval` as synchronous; eve awaits approval policies, so an async policy is valid.
export const approvalPolicy = async (...[tool, context]: Parameters<EveNeedsApproval>) => {
  const required = await decideApproval(tool.slug, context.toolInput);
  const principal = readPrincipal(context.session.auth.current);
  if (required && principal) {
    await parkApproval(db(), {
      callId: context.callId,
      userId: principal.userId,
      eveSessionId: context.session.id,
      bootId: bootId(),
    });
  }
  return required;
};
const needsApproval = approvalPolicy as unknown as EveNeedsApproval;

const GUARD_DENIALS = {
  missing: "This action has no approval record, so it was not run. Ask the person to confirm it again.",
  restarted:
    "Pidge restarted while this action was waiting for approval, so it was not run. Tell the person and ask them to confirm it again.",
  already_started:
    "This action was already attempted once before a restart; its outcome is unknown, so it was not run again. Tell the person and let them check before trying again.",
} as const;

const multiResult = z.object({
  results: z.array(z.object({ index: z.number().optional(), error: z.unknown().optional() }).passthrough()),
});

/** Per-entry outcome of an executed call; `successful` already reflects Composio's `resultType`. */
export function entryOutcomes(
  slugs: string[],
  response: { successful: boolean; data: unknown },
): AuditEntry["outcome"][] {
  const parsed = multiResult.safeParse(response.data);
  if (slugs.length <= 1 || !parsed.success) return slugs.map(() => (response.successful ? "completed" : "failed"));
  return slugs.map((_slug, position) => {
    const entry = parsed.data.results.find((item) => item.index === position) ?? parsed.data.results[position];
    return entry && !entry.error ? "completed" : "failed";
  });
}

/**
 * Provider execute hook: denies browser toolkits outright (spec §6, D5), requires a Pidge principal, and writes a
 * metadata-only audit row per executed app tool (spec §14). It never retries: one call, one provider request.
 */
export const executeHook: EveHook = async (ctx, next) => {
  const session = ctx.context.eve.session;
  const principal = readPrincipal(session.auth.current);
  if (!principal) return ctx.deny("No authenticated Pidge user for this conversation.");
  const slugs =
    ctx.request.slug.toUpperCase() === MULTI_EXECUTE
      ? multiExecuteSlugs(ctx.request.args)
      : [ctx.request.slug.toUpperCase()];
  const decisions = slugs.map((slug) => classifyAppTool(slug, hintsFor(slug)));
  const audit = (outcomes: AuditEntry["outcome"][], composioLogId: string | null) =>
    recordActions(
      db(),
      decisions.map((decision, position) => ({
        userId: principal.userId,
        eveSessionId: session.id,
        toolSlug: decision.slug,
        risk: decision.risk,
        approval: decision.approval ? "required" : "not_required",
        outcome: outcomes[position] ?? "error",
        composioLogId,
      })),
    ).catch((error) => console.warn("pidge.audit_failed", { error: String(error).slice(0, 200) }));

  if (slugs.some(isBrowserSlug)) {
    await audit(
      slugs.map(() => "denied"),
      null,
    );
    return ctx.deny("Browser tools are not available here. Use run_browser for browser tasks.");
  }
  if (decisions.some((decision) => decision.approval)) {
    const guard = await claimApprovedExecution(db(), {
      callId: ctx.context.eve.callId,
      userId: principal.userId,
      eveSessionId: session.id,
      bootId: bootId(),
    });
    if (!guard.ok) {
      await audit(
        slugs.map(() => "denied"),
        null,
      );
      console.warn("pidge.approval_guard_denied", { reason: guard.reason, sessionId: session.id });
      return ctx.deny(GUARD_DENIALS[guard.reason]);
    }
  }
  try {
    const response = await next();
    await audit(entryOutcomes(slugs, response), typeof response.logId === "string" ? response.logId : null);
    return response;
  } catch (error) {
    await audit(
      slugs.map(() => "error"),
      null,
    );
    throw error;
  }
};

let client: Composio<EveProvider> | undefined;

/** Lazily constructed Composio client for user-scoped sessions (Eve provider, hooks, central approval policy). */
export function composio(): Composio<EveProvider> {
  client ??= new Composio({
    apiKey: env().COMPOSIO_API_KEY,
    allowTracking: false,
    provider: new EveProvider({ hooks: { execute: executeHook }, needsApproval }),
  });
  return client;
}

let plain: Composio | undefined;

/** Plain client (no Eve provider) for server-side connection management and tool metadata. */
export function composioAdmin(): Composio {
  plain ??= new Composio({ apiKey: env().COMPOSIO_API_KEY, allowTracking: false });
  return plain;
}
