import { z } from "zod";

/**
 * Central approval baseline for every Composio tool call (spec §9.6, §9.7; docs/decisions.md D9).
 * Pure functions: classification depends only on the slug, the tool's hint tags, and the call input.
 */

export type ToolHints = {
  readOnly: boolean;
  destructive: boolean;
  /** Toolkit slug, used to strip the toolkit prefix before matching action words. */
  toolkit?: string;
};

export type Risk =
  | "meta_read"
  | "read"
  | "destructive"
  | "high_risk"
  | "outbound"
  | "other_write"
  | "connection_change"
  | "browser_denied";

export type EntryDecision = { slug: string; risk: Risk; approval: boolean };

const HIGH_RISK_WORDS: Record<string, true> = {
  DELETE: true,
  REMOVE: true,
  TRASH: true,
  REVOKE: true,
  TRANSFER: true,
  PAY: true,
  PAYMENT: true,
  CHARGE: true,
  REFUND: true,
  PURCHASE: true,
  ORDER: true,
  CHECKOUT: true,
  BOOK: true,
  RESERVE: true,
  INVITE: true,
  SHARE: true,
  PERMISSION: true,
  ROLE: true,
  BULK: true,
};
const OUTBOUND_WORDS: Record<string, true> = {
  SEND: true,
  POST: true,
  REPLY: true,
  PUBLISH: true,
  FORWARD: true,
  COMMENT: true,
};

export const READ_ONLY_META_TOOLS: Record<string, true> = {
  COMPOSIO_SEARCH_TOOLS: true,
  COMPOSIO_GET_TOOL_SCHEMAS: true,
};
export const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
export const MANAGE_CONNECTIONS = "COMPOSIO_MANAGE_CONNECTIONS";

const multiExecuteInput = z.object({
  tools: z.array(z.object({ tool_slug: z.unknown(), arguments: z.unknown() }).partial().nullable()),
});
const manageConnectionsInput = z.object({
  reinitiate_all: z.unknown(),
  toolkits: z.array(z.object({ action: z.unknown() }).partial().nullable()),
});

/** Browser execution is only reachable through the server-side `run_browser` tool (spec §6, D5). */
export function isBrowserSlug(slug: string): boolean {
  const upper = slug.toUpperCase();
  return upper.startsWith("BROWSER_USE_") || upper.startsWith("BROWSER_TOOL_");
}

function actionWords(slug: string, toolkit: string | undefined): string[] {
  const upper = slug.toUpperCase();
  const prefix = toolkit ? `${toolkit.toUpperCase()}_` : "";
  const action = prefix && upper.startsWith(prefix) ? upper.slice(prefix.length) : upper.split("_").slice(1).join("_");
  return action.split("_").filter(Boolean);
}

/**
 * Classifies one app tool. Precedence follows §9.7: destructive hint, then high-risk words, then outbound words,
 * then read-only hint; anything else is an "other write". Unknown metadata is treated as an other write.
 * D9: other writes also require approval because code cannot verify they exactly match the person's request.
 */
export function classifyAppTool(slug: string, hints: ToolHints | null): EntryDecision {
  if (isBrowserSlug(slug)) return { slug, risk: "browser_denied", approval: true };
  const words = actionWords(slug, hints?.toolkit);
  if (hints?.destructive) return { slug, risk: "destructive", approval: true };
  if (words.some((word) => HIGH_RISK_WORDS[word])) return { slug, risk: "high_risk", approval: true };
  if (words.some((word) => OUTBOUND_WORDS[word])) return { slug, risk: "outbound", approval: true };
  if (hints?.readOnly) return { slug, risk: "read", approval: false };
  return { slug, risk: "other_write", approval: true };
}

/** Entries of a multi-execute call, or null when the input is not a well-formed batch. */
export function multiExecuteEntries(input: unknown): { slug: string; args: Record<string, unknown> }[] | null {
  const parsed = multiExecuteInput.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data.tools.map((entry) => ({
    slug: typeof entry?.tool_slug === "string" ? entry.tool_slug.toUpperCase() : "UNKNOWN_TOOL",
    args:
      entry?.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
        ? Object.fromEntries(Object.entries(entry.arguments))
        : {},
  }));
}

export function multiExecuteSlugs(input: unknown): string[] {
  return (multiExecuteEntries(input) ?? []).map((entry) => entry.slug);
}

/** Connection actions that only start a new connection or read status. Anything else changes existing credentials. */
const NON_MUTATING_CONNECTION_ACTIONS: Record<string, true> = {
  add: true,
  list: true,
  check: true,
  status: true,
  get: true,
};

/** Connection management that replaces or removes credentials needs approval; adding or checking connections does not. */
export function classifyManageConnections(input: unknown): EntryDecision {
  const parsed = manageConnectionsInput.partial().safeParse(input ?? {});
  const changesExisting =
    !parsed.success ||
    parsed.data.reinitiate_all === true ||
    (parsed.data.toolkits ?? []).some(
      (toolkit) =>
        toolkit?.action !== undefined &&
        !(typeof toolkit.action === "string" && NON_MUTATING_CONNECTION_ACTIONS[toolkit.action.toLowerCase()]),
    );
  return {
    slug: MANAGE_CONNECTIONS,
    risk: changesExisting ? "connection_change" : "meta_read",
    approval: changesExisting,
  };
}

/**
 * Decision for a whole Composio meta-tool call. A multi-execute batch needs approval when any entry does, and every
 * entry is evaluated (a safe entry never hides an unsafe one). Malformed batches need approval.
 */
export function classifyComposioCall(
  metaSlug: string,
  input: unknown,
  hintsFor: (slug: string) => ToolHints | null,
): { approval: boolean; entries: EntryDecision[] } {
  const slug = metaSlug.toUpperCase();
  if (READ_ONLY_META_TOOLS[slug]) return { approval: false, entries: [{ slug, risk: "meta_read", approval: false }] };
  if (slug === MANAGE_CONNECTIONS) {
    const entry = classifyManageConnections(input);
    return { approval: entry.approval, entries: [entry] };
  }
  if (slug === MULTI_EXECUTE) {
    const entries = multiExecuteEntries(input);
    if (!entries || entries.length === 0) {
      return { approval: true, entries: [{ slug, risk: "other_write", approval: true }] };
    }
    const decisions = entries.map((entry) => classifyAppTool(entry.slug, hintsFor(entry.slug)));
    return { approval: decisions.some((decision) => decision.approval), entries: decisions };
  }
  // Any other meta tool (workbench, bash, proxy) is disabled by session policy; if one appears, ask first.
  const entry = classifyAppTool(slug, hintsFor(slug));
  return { approval: entry.approval, entries: [entry] };
}

const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|otp|cvv|card[_-]?number/i;
const MAX_VALUE = 280;
const MAX_PROMPT = 1800;

function renderValue(key: string, value: unknown): string {
  if (SECRET_KEY.test(key)) return "[hidden]";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/**
 * Approval prompt with the exact material terms (recipients/destination, content, amounts) of every entry that is
 * about to run (spec §9.7: "Eve approval showing recipients/destination and content").
 */
export function approvalPrompt(metaSlug: string, input: unknown): string {
  const slug = metaSlug.toUpperCase();
  const lines: string[] = [];
  if (slug === MULTI_EXECUTE) {
    const entries = multiExecuteEntries(input) ?? [];
    lines.push(entries.length === 1 ? "Approve this action?" : `Approve these ${entries.length} actions?`);
    for (const entry of entries) {
      lines.push("", `• ${entry.slug}`);
      for (const [key, value] of Object.entries(entry.args)) lines.push(`  ${key}: ${renderValue(key, value)}`);
    }
  } else if (slug === MANAGE_CONNECTIONS) {
    lines.push("Approve changing your app connections?", JSON.stringify(input ?? {}).slice(0, MAX_VALUE));
  } else {
    lines.push(`Approve ${slug}?`);
    const args = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [];
    for (const [key, value] of args) lines.push(`  ${key}: ${renderValue(key, value)}`);
  }
  lines.push("", "👍 to approve, 👎 to cancel.");
  const text = lines.join("\n");
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)}…\n(see web chat for the full request)` : text;
}
