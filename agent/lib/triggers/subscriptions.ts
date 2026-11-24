import { z } from "zod";
import type { Database } from "../../../db/client";
import { deliveryAllowed, getBinding } from "../../../db/services/conversations";
import {
  activateSubscription,
  listSubscriptions,
  recentEvents,
  removedSubscription,
  reserveSubscription,
  stopSubscription,
  subscriptionFor,
  uncertainSubscription,
} from "../../../db/services/triggers";
import { env } from "../../../shared/environment/env";
import { composioAdmin } from "../composio/client";
import { listConnections } from "../composio/connections";
import { toolkitPolicy } from "../composio/sessions";
import { readPrincipal } from "../identity/principal";

// The pinned SDK forwards options to @composio/client verbatim. Its public options type only lists signal;
// the transport supports maxRetries, as used by the SDK itself for non-idempotent tool execution.
function singleRequest(): { signal: AbortSignal; maxRetries: 0 } {
  return { signal: AbortSignal.timeout(30_000), maxRetries: 0 };
}

export const triggerInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("discover"),
    toolkit: z.string().regex(/^[a-z0-9_]{2,64}$/),
    slug: z.string().max(150).optional(),
    cursor: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal("create"),
    connected_account_id: z.string().min(1).max(150),
    trigger_slug: z.string().regex(/^[A-Z0-9_]{2,150}$/),
    config: z.record(z.string(), z.unknown()),
    instruction: z.string().trim().min(1).max(4000),
  }),
  z.object({ action: z.literal("list") }),
  z.object({ action: z.enum(["disable", "remove"]), id: z.uuid() }),
]);
export type TriggerInput = z.infer<typeof triggerInput>;
export function triggerWrite(input: TriggerInput | undefined) {
  return !input || (input.action !== "list" && input.action !== "discover");
}
export function triggerManager(auth: Parameters<typeof readPrincipal>[0]) {
  const principal = readPrincipal(auth);
  if (
    !principal ||
    (principal.channel === "imessage" && (principal.triggerRunId || principal.scheduledRunId || principal.notifyText))
  )
    return null;
  return principal;
}

function allowed(toolkit: string) {
  const policy = toolkitPolicy(env().COMPOSIO_TOOLKIT_ALLOWLIST, env().COMPOSIO_TOOLKIT_DENYLIST);
  return (
    policy.kind !== "none" &&
    (policy.kind === "enable" ? policy.toolkits.includes(toolkit) : !policy.toolkits.includes(toolkit))
  );
}

export async function manageTriggers(
  database: Database,
  input: TriggerInput,
  context: { auth: Parameters<typeof readPrincipal>[0]; sessionId: string; callId: string },
) {
  const principal = triggerManager(context.auth);
  if (!principal) return { status: "refused", error: "Only a signed-in person's own turn can manage app events." };
  if (input.action === "list") {
    const subscriptions = await listSubscriptions(database, principal.userId);
    return {
      subscriptions: subscriptions.map(
        ({ id, connectedAccountId, triggerSlug, config, instruction, status, eveSessionId }) => ({
          id,
          connectedAccountId,
          triggerSlug,
          config,
          delivery:
            eveSessionId === context.sessionId
              ? "this iMessage conversation"
              : "another of your iMessage conversations",
          instruction,
          status,
        }),
      ),
      events: await recentEvents(database, principal.userId),
    };
  }
  if (input.action === "discover") {
    if (!allowed(input.toolkit)) throw new Error("That app isn't available on this deployment.");
    const connections = (await listConnections(principal.userId)).filter(
      (c) => c.toolkit === input.toolkit && c.status === "ACTIVE",
    );
    if (input.slug) {
      const type = await composioAdmin().triggers.getType(input.slug);
      if (type.toolkit.slug !== input.toolkit) throw new Error("Trigger belongs to a different app.");
      return { connections, type };
    }
    return {
      connections,
      types: await composioAdmin().triggers.listTypes({ toolkits: [input.toolkit], limit: 20, cursor: input.cursor }),
    };
  }
  if (input.action !== "create") {
    const existing = await subscriptionFor(database, principal.userId, input.id);
    if (!existing) return { status: "not_found" };
    if (existing.status === "removed") return { status: "removed" };
    const stopped = await stopSubscription(database, principal.userId, input.id);
    if (!stopped?.triggerId)
      return {
        status: "refused",
        error:
          "Setup outcome is uncertain. An operator must inspect the Composio instance before changing it. No events will run locally.",
      };
    try {
      if (input.action === "disable") await composioAdmin().triggers.disable(stopped.triggerId, singleRequest());
      else {
        await composioAdmin().triggers.delete(stopped.triggerId, singleRequest());
        await removedSubscription(database, principal.userId, input.id);
      }
      return { status: input.action === "disable" ? "disabled" : "removed" };
    } catch {
      return {
        status: "disabled",
        error:
          "Stopped locally. Remote cleanup was not confirmed; inspect the instance in Composio before retrying removal.",
      };
    }
  }
  if (!env().COMPOSIO_WEBHOOK_SECRET)
    return { status: "refused", error: "App-event delivery is not configured on this deployment." };
  if (principal.channel !== "imessage")
    return {
      status: "refused",
      error: "Set this up from the iMessage conversation where Pidge should send the results.",
    };
  const binding = await getBinding(database, context.sessionId);
  if (
    binding?.userId !== principal.userId ||
    binding.externalConversationId !== principal.conversation ||
    binding.deliveryHandle !== principal.handle ||
    !(await deliveryAllowed(database, context.sessionId, principal.userId))
  )
    throw new Error("Conversation is no longer linked.");
  const connection = (await listConnections(principal.userId)).find(
    (c) => c.id === input.connected_account_id && c.status === "ACTIVE",
  );
  if (!connection || !allowed(connection.toolkit))
    throw new Error("Choose one of your own active, allowed connections.");
  const type = await composioAdmin().triggers.getType(input.trigger_slug);
  if (type.toolkit.slug !== connection.toolkit) throw new Error("Trigger and connection must belong to the same app.");
  if (JSON.stringify(input.config).length > 8000) throw new Error("Trigger configuration is too large.");
  const existingRemote = await composioAdmin().triggers.listActive({
    connectedAccountIds: [connection.id],
    triggerNames: [type.slug],
    showDisabled: true,
    limit: 1,
  });
  if (existingRemote.items.length)
    return {
      status: "refused",
      error:
        "Composio already has this event type on that account. Inspect the existing instance before creating another subscription.",
    };
  const sub = await reserveSubscription(database, {
    userId: principal.userId,
    requestKey: context.callId,
    eveSessionId: context.sessionId,
    conversation: principal.conversation,
    handle: principal.handle,
    connectedAccountId: connection.id,
    toolkit: connection.toolkit,
    triggerSlug: type.slug,
    instruction: input.instruction,
    config: input.config,
    status: "creating",
  });
  if (!sub)
    return {
      status: "refused",
      error:
        "This setup was already attempted, or that account already has this event type. Inspect app_events list before making changes.",
    };
  try {
    // No SDK retries of a remote upsert. A timeout may mean it succeeded; retain a blocked reservation for inspection.
    const remote = await composioAdmin().triggers.create(
      principal.userId,
      type.slug,
      { connectedAccountId: connection.id, triggerConfig: input.config },
      singleRequest(),
    );
    await activateSubscription(database, sub.id, remote.triggerId);
    return {
      status: "active",
      id: sub.id,
      trigger: type.slug,
      instruction: sub.instruction,
      delivery: "this iMessage conversation",
      type: remote.type,
      pollingInterval: remote.pollingInterval,
    };
  } catch {
    await uncertainSubscription(database, sub.id);
    return {
      status: "uncertain",
      id: sub.id,
      error:
        "Setup was not confirmed. No events will run locally. Do not repeat creation; ask the operator to inspect this account and event type in Composio.",
    };
  }
}
