import { appOrigin, env } from "../../../shared/environment/env";
import { composioAdmin } from "./client";
import { sessionConfig, toolkitPolicy } from "./sessions";

export type Connection = { id: string; toolkit: string; alias: string | null; status: string; createdAt: string };

const TOOLKIT_SLUG = /^[a-z0-9_]{2,64}$/;

/**
 * The signed-in user's connected accounts, read live from Composio (spec §9.4: no token cache). Only non-secret
 * fields are returned; connection `data`/`state`/`params` never leave this module.
 */
export async function listConnections(userId: string): Promise<Connection[]> {
  const response = await composioAdmin().connectedAccounts.list({ userIds: [userId], limit: 100 });
  return response.items.map((item) => ({
    id: item.id,
    toolkit: item.toolkit.slug,
    alias: item.alias ?? null,
    status: item.status,
    createdAt: item.createdAt,
  }));
}

/** Creates a Connect Link for one toolkit the deployment policy allows (never a browser toolkit). */
export async function startConnection(userId: string, toolkit: string, alias?: string): Promise<string> {
  const slug = toolkit.trim().toLowerCase();
  if (!TOOLKIT_SLUG.test(slug)) throw new Error("Unknown app.");
  const policy = toolkitPolicy(env().COMPOSIO_TOOLKIT_ALLOWLIST, env().COMPOSIO_TOOLKIT_DENYLIST);
  if (policy.kind === "none") throw new Error("App connections are disabled on this deployment.");
  const allowed = policy.kind === "enable" ? policy.toolkits.includes(slug) : !policy.toolkits.includes(slug);
  if (!allowed) throw new Error("That app isn't available on this deployment.");
  const callbackUrl = `${appOrigin()}/connections/complete`;
  const session = await composioAdmin().create(userId, sessionConfig(policy, callbackUrl));
  const cleanAlias = alias?.trim().slice(0, 40) || undefined;
  const request = await session.authorize(slug, { callbackUrl, ...(cleanAlias ? { alias: cleanAlias } : {}) });
  if (!request.redirectUrl) throw new Error("Composio did not return a Connect Link.");
  return request.redirectUrl;
}

/** Disconnects one of the user's own accounts; any other account ID is refused. */
export async function disconnect(userId: string, connectedAccountId: string): Promise<boolean> {
  const owned = (await listConnections(userId)).some((connection) => connection.id === connectedAccountId);
  if (!owned) return false;
  await composioAdmin().connectedAccounts.delete(connectedAccountId);
  return true;
}
