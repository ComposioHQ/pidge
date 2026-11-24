import { composioAdmin } from "@/agent/lib/composio/client";
import { handleTriggerWebhook } from "@/agent/lib/triggers/webhook";
import { db } from "@/db/client";
import { ingestEvent } from "@/db/services/triggers";
import { env } from "@/shared/environment/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTriggerWebhook(request, env().COMPOSIO_WEBHOOK_SECRET, composioAdmin().triggers, (event) =>
    ingestEvent(db(), event),
  );
}
