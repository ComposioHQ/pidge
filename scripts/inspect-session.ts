// Operator tool (runs on the server, needs BETTER_AUTH_SECRET): summarizes one Eve session's recorded events for
// verification. Prints metadata only (event types, turns, tools, outcomes) unless --content is passed.
// Usage: pnpm tsx --env-file=.env.local scripts/inspect-session.ts <eveSessionId> [--content] [--json out.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "eve/client";
import { db } from "@/db/client";
import { getBinding } from "@/db/services/conversations";
import { env } from "@/shared/environment/env";
import { signWebToken } from "@/shared/identity/web-token";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { content: { type: "boolean", default: false }, json: { type: "string" } },
});
const sessionId = positionals[0];
if (!sessionId) throw new Error("usage: inspect-session.ts <eveSessionId>");
const binding = await getBinding(db(), sessionId);
if (!binding) throw new Error("no conversation binding for that session");

const client = new Client({
  host: env().EVE_INTERNAL_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`,
  auth: { bearer: signWebToken(env().BETTER_AUTH_SECRET, { sub: binding.userId, sid: sessionId }) },
  redirect: "error",
});
const events: unknown[] = [];
const clip = (text: unknown) => (values.content ? String(text).slice(0, 300) : `[${String(text).length} chars]`);
for await (const event of client.sessions.attach(sessionId).stream({ follow: false })) {
  events.push(event);
  const { type, data, meta } = event as { type: string; data: Record<string, unknown>; meta: { at: string } };
  const at = meta.at.slice(11, 23);
  if (type === "turn.started" || type === "turn.completed" || type === "turn.cancelled" || type === "turn.failed") {
    console.log(at, type, data.turnId ?? "");
  } else if (type === "message.received") {
    console.log(at, "  in ", data.turnId, clip(data.message));
  } else if (type === "message.completed") {
    console.log(at, "  out", data.turnId, clip(data.message));
  } else if (type === "actions.requested") {
    const actions = data.actions as { toolName: string }[];
    console.log(at, "  call", actions.map((a) => a.toolName).join(", "));
  } else if (type === "input.requested" || type === "approval.settled" || type === "input.resolved") {
    console.log(at, " ", type);
  }
}
if (values.json) writeFileSync(values.json, JSON.stringify({ sessionId, events }, null, 2), { mode: 0o600 });
process.exit(0);
