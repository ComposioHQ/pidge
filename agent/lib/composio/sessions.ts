import type { EveTool, EveToolCollection } from "@composio/experimental/eve";
import { and, eq, isNull } from "drizzle-orm";
import { defineDurableCallback } from "eve/tools";
import { db } from "../../../db/client";
import { conversationBindings } from "../../../db/schema";
import { getBinding } from "../../../db/services/conversations";
import { appOrigin, env } from "../../../shared/environment/env";
import { readPrincipal } from "../identity/principal";
import { composio } from "./client";
import { approvalPrompt, MANAGE_CONNECTIONS } from "./policy";

/** Toolkits user sessions can never reach; browser work goes through `run_browser` only (spec §6, §9.3, D5). */
export const BROWSER_TOOLKITS = ["browser_use", "browser_tool"] as const;

export type ToolkitPolicy =
  | { kind: "none" }
  | { kind: "enable"; toolkits: string[] }
  | { kind: "disable"; toolkits: string[] };

/**
 * Deployment toolkit policy (spec §9.3): no allowlist exposes the whole catalog; an explicitly empty allowlist
 * disables every app toolkit; browser toolkits are always excluded; denylist entries are always removed.
 */
export function toolkitPolicy(allowlist: string[] | undefined, denylist: string[] | undefined): ToolkitPolicy {
  const blocked = new Set<string>([...BROWSER_TOOLKITS, ...(denylist ?? [])]);
  if (allowlist !== undefined) {
    const enabled = allowlist.filter((toolkit) => !blocked.has(toolkit));
    return enabled.length === 0 ? { kind: "none" } : { kind: "enable", toolkits: enabled };
  }
  return { kind: "disable", toolkits: [...blocked] };
}

/** Composio session config for one user conversation (spec §9.3). */
export function sessionConfig(policy: Exclude<ToolkitPolicy, { kind: "none" }>, callbackUrl: string) {
  return {
    toolkits: policy.kind === "enable" ? { enable: policy.toolkits } : { disable: policy.toolkits },
    manageConnections: { enable: true, callbackUrl },
    sandbox: { enable: false },
    proxyExecute: false,
    multiAccount: { enable: true, requireExplicitSelection: true },
  };
}

type ComposioSession = Awaited<ReturnType<ReturnType<typeof composio>["create"]>>;
export type ToolSource = { tools: () => Promise<EveToolCollection> };

const TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");
const CALLBACK_DESCRIPTOR = Symbol.for("eve:durable-dynamic-callback");

/**
 * Adds an approval prompt that lists the exact terms of the call (spec §9.7) to every provider tool that has an
 * approval policy. The prompt is a durable eve callback, registered through the same global descriptor protocol the
 * Composio provider uses for its own callbacks, so eve can rebuild it like the provider's execute/approval callbacks.
 */
export function withApprovalPrompts(tools: EveToolCollection): EveToolCollection {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (typeof tool.approval !== "function") return [name, tool];
      const prompt = defineDurableCallback({
        closure: { slug: name },
        callback: (closure: { slug: string }, args: { input: unknown }) => approvalPrompt(closure.slug, args.input),
      });
      const copy: Record<string | symbol, unknown> = { ...tool, approval: { request: tool.approval, prompt } };
      for (const symbol of Object.getOwnPropertySymbols(tool)) {
        copy[symbol] = (tool as unknown as Record<symbol, unknown>)[symbol];
      }
      const callbacks = copy[TOOL_CALLBACKS] as Record<string, unknown> | undefined;
      copy[TOOL_CALLBACKS] = {
        ...callbacks,
        approvalPrompt: (prompt as unknown as Record<symbol, unknown>)[CALLBACK_DESCRIPTOR],
      };
      return [name, copy as unknown as EveTool];
    }),
  );
}

const empty: ToolSource = { tools: async () => ({}) };
/** Wrapped sources keyed by Composio session ID so the resolver's identity cache reuses tools across steps. */
const sources = new Map<string, ToolSource>();

function sourceFor(session: ComposioSession): ToolSource {
  let source = sources.get(session.sessionId);
  if (!source) {
    let pending: Promise<EveToolCollection> | undefined;
    source = {
      tools: () => {
        pending ??= session.tools().then(withApprovalPrompts, (error: unknown) => {
          pending = undefined;
          throw error;
        });
        return pending;
      },
    };
    if (sources.size > 500) sources.delete(sources.keys().next().value as string);
    sources.set(session.sessionId, source);
  }
  return source;
}

/**
 * Resolves the Composio session for one Eve conversation (spec §9.2): the authenticated internal user's UUID is the
 * Composio user ID; the session ID is stored on the conversation binding and restored on later steps after an
 * ownership check. Missing principals, missing or foreign bindings fail closed. Scheduled report turns get the
 * same user-scoped tools minus connection administration (spec §10.3); writes still need approval.
 */
export async function resolveConversationTools(context: {
  session: { id: string; auth: { current: Parameters<typeof readPrincipal>[0] } };
}): Promise<ToolSource> {
  const principal = readPrincipal(context.session.auth.current);
  if (!principal) return empty;
  const source = await conversationSource(context.session.id, principal.userId);
  if (principal.channel !== "imessage" || (!principal.scheduledRunId && !principal.triggerRunId)) return source;
  return {
    tools: async () => {
      const { [MANAGE_CONNECTIONS]: _admin, ...rest } = await source.tools();
      return rest;
    },
  };
}

async function conversationSource(eveSessionId: string, userId: string): Promise<ToolSource> {
  const policy = toolkitPolicy(env().COMPOSIO_TOOLKIT_ALLOWLIST, env().COMPOSIO_TOOLKIT_DENYLIST);
  if (policy.kind === "none") return empty;

  const binding = await getBinding(db(), eveSessionId);
  if (!binding || binding.userId !== userId) throw new Error("Conversation is not owned by this user.");
  if (binding.composioSessionId) {
    const cached = sources.get(binding.composioSessionId);
    if (cached) return cached;
    return sourceFor(await composio().use(binding.composioSessionId));
  }
  const created = await composio().create(userId, sessionConfig(policy, `${appOrigin()}/connections/complete`));
  const [stored] = await db()
    .update(conversationBindings)
    .set({ composioSessionId: created.sessionId, updatedAt: new Date() })
    .where(and(eq(conversationBindings.id, binding.id), isNull(conversationBindings.composioSessionId)))
    .returning({ id: conversationBindings.id });
  if (!stored) {
    // A concurrent step stored a session first; use that one so the conversation keeps a single session.
    const current = await getBinding(db(), eveSessionId);
    if (!current?.composioSessionId || current.userId !== userId) throw new Error("Composio session race.");
    return sourceFor(await composio().use(current.composioSessionId));
  }
  return sourceFor(created);
}
