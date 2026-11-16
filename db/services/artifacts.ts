import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { artifacts } from "../schema";

/**
 * Private artifact storage on local disk (docs/decisions.md D6). Object keys are random UUIDs, never derived from
 * user input; files are written owner-only and become readable through `/artifacts/[artifactId]` only after the row
 * is marked ready and only for the owning user.
 */
export type ArtifactInput = {
  userId: string;
  eveSessionId?: string | null;
  browserTaskId?: string | null;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export async function storeArtifact(db: Database, root: string, input: ArtifactInput): Promise<{ id: string }> {
  const objectKey = randomUUID();
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  // Bind the artifact to its owner before any bytes are reachable (spec §11.4).
  const [row] = await db
    .insert(artifacts)
    .values({
      userId: input.userId,
      eveSessionId: input.eveSessionId ?? null,
      browserTaskId: input.browserTaskId ?? null,
      objectKey,
      filename: sanitizeFilename(input.filename),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      ready: false,
    })
    .returning({ id: artifacts.id });
  if (!row) throw new Error("artifact row not created");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `${objectKey}.partial`);
  await writeFile(temporary, input.bytes, { mode: 0o600 });
  await rename(temporary, join(root, objectKey));
  await db.update(artifacts).set({ ready: true }).where(eq(artifacts.id, row.id));
  return { id: row.id };
}

export type ReadableArtifact = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  bytes: Buffer;
};

/** Returns the artifact only for its owner, only when ready, and only if the stored bytes still match the hash. */
export async function readOwnedArtifact(
  db: Database,
  root: string,
  input: { artifactId: string; userId: string },
): Promise<ReadableArtifact | null> {
  if (!/^[0-9a-f-]{36}$/i.test(input.artifactId)) return null;
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.userId, input.userId), eq(artifacts.ready, true)))
    .limit(1);
  if (!row) return null;
  const bytes = await readFile(join(root, row.objectKey));
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) return null;
  return { filename: row.filename, mimeType: row.mimeType, sizeBytes: row.sizeBytes, sha256: row.sha256, bytes };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/[^\w.\- ]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "artifact";
}

/** Response headers for private artifact bytes (spec §15.2, §17.2). */
export function artifactHeaders(artifact: Omit<ReadableArtifact, "bytes">): Headers {
  const inline = artifact.mimeType.startsWith("image/") || artifact.mimeType === "application/pdf";
  return new Headers({
    "Content-Type": artifact.mimeType,
    "Content-Length": String(artifact.sizeBytes),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.filename}"`,
    ETag: `"${artifact.sha256}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}
