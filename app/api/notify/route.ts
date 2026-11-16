import { parseNotifyRequest } from "@/agent/lib/notify/request";
import { env } from "@/shared/environment/env";
import { eveOrigin } from "@/web/eve/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public path for owner notifications (docs/decisions.md D14). The agent service owns the handler, auth, and send
 * (`agent/channels/notify.ts` at `/eve/v1/notify`); this forwards the request unchanged.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseNotifyRequest(request, env().PIDGE_NOTIFY_TOKEN);
  if (parsed instanceof Response) return parsed;
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "application/json" });
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const upstream = await fetch(`${eveOrigin()}/eve/v1/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed),
    redirect: "error",
    cache: "no-store",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
