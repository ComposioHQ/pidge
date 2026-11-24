import type { Composio } from "@composio/core";
import { z } from "zod";
import type { TriggerEvent } from "../../../db/services/triggers";

const MAX_BODY = 64 * 1024;

/** Bounded raw bytes, before parsing. Never log provider content or signature material. */
export async function webhookBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Triggers = Pick<Composio["triggers"], "verifyWebhook">;
export async function handleTriggerWebhook(
  request: Request,
  secret: string | undefined,
  triggers: Triggers,
  ingest: (event: TriggerEvent) => Promise<string>,
): Promise<Response> {
  if (!secret) return new Response("App events disabled", { status: 503 });
  const body = await webhookBody(request);
  if (body === null) return new Response("Payload too large", { status: 413 });
  let result: Awaited<ReturnType<Triggers["verifyWebhook"]>>;
  try {
    result = await triggers.verifyWebhook({
      id: request.headers.get("webhook-id") ?? "",
      timestamp: request.headers.get("webhook-timestamp") ?? "",
      signature: request.headers.get("webhook-signature") ?? "",
      payload: body,
      secret,
    });
  } catch {
    return new Response("Invalid webhook", { status: 401 });
  }
  // Require V3 routing fields and a stable trigger log id, which survives delivery retries with new webhook ids.
  const raw = result.rawPayload;
  if (result.version !== "V3" || !("type" in raw) || raw.type !== "composio.trigger.message")
    return new Response("Ignored");
  const meta = "metadata" in raw ? raw.metadata : undefined;
  if (
    !meta ||
    !z.uuid().safeParse(meta.user_id).success ||
    ![meta.trigger_id, meta.trigger_slug, meta.connected_account_id, meta.user_id, meta.log_id].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 200,
    )
  )
    return new Response("Invalid event", { status: 400 });
  try {
    const status = await ingest({
      triggerId: meta.trigger_id as string,
      triggerSlug: meta.trigger_slug as string,
      connectedAccountId: meta.connected_account_id as string,
      userId: meta.user_id as string,
      eventId: meta.log_id as string,
      payload: raw.data,
    });
    return Response.json({ status });
  } catch {
    // No acknowledgement until durable insertion succeeds. Composio may retry this delivery safely.
    return new Response("Event storage unavailable", { status: 503 });
  }
}
