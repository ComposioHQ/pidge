import { db } from "@/db/client";
import { artifactHeaders, readOwnedArtifact } from "@/db/services/artifacts";
import { env } from "@/shared/environment/env";
import { currentUser } from "@/web/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }): Promise<Response> {
  const user = await currentUser(request.headers);
  // Same response for "not signed in", "not yours", and "missing" so artifact IDs reveal nothing.
  const notFound = new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
  if (!user) return notFound;
  const { artifactId } = await context.params;
  const artifact = await readOwnedArtifact(db(), env().ARTIFACT_STORAGE_DIR, { artifactId, userId: user.id });
  if (!artifact) return notFound;
  return new Response(new Uint8Array(artifact.bytes), { status: 200, headers: artifactHeaders(artifact) });
}
