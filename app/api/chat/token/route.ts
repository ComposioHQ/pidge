import { currentUser } from "@/web/auth/server";
import { webTokenFor } from "@/web/eve/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mints a short-lived token for one Eve session the signed-in user owns. */
export async function POST(request: Request): Promise<Response> {
  const user = await currentUser(request.headers);
  const noStore = { "Cache-Control": "no-store" };
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const token = sessionId ? await webTokenFor(user.id, sessionId) : null;
  if (!token) return Response.json({ error: "not_found" }, { status: 404, headers: noStore });
  return Response.json({ token }, { headers: noStore });
}
