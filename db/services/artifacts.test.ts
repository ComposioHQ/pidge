import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { artifacts } from "../schema";
import { artifactHeaders, readOwnedArtifact, sanitizeFilename, storeArtifact } from "./artifacts";

let root: string;

describe("private artifacts", () => {
  beforeEach(async () => {
    await resetDb();
    root = await mkdtemp(join(tmpdir(), "pidge-artifacts-"));
  });

  it("returns bytes only to the owning user", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const bytes = new TextEncoder().encode("booking confirmation");
    const { id } = await storeArtifact(testDb(), root, {
      userId: alice,
      filename: "confirmation.txt",
      mimeType: "text/plain",
      bytes,
    });
    const read = await readOwnedArtifact(testDb(), root, { artifactId: id, userId: alice });
    expect(read?.bytes.toString("utf8")).toBe("booking confirmation");
    expect(await readOwnedArtifact(testDb(), root, { artifactId: id, userId: bob })).toBeNull();
  });

  it("never serves artifacts that are not ready, are malformed IDs, or whose bytes changed on disk", async () => {
    const alice = await makeUser("Alice");
    const { id } = await storeArtifact(testDb(), root, {
      userId: alice,
      filename: "a.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("original"),
    });
    expect(await readOwnedArtifact(testDb(), root, { artifactId: "../../etc/passwd", userId: alice })).toBeNull();

    const [key] = await readdir(root);
    if (!key) throw new Error("no stored object");
    await writeFile(join(root, key), "tampered");
    expect(await readOwnedArtifact(testDb(), root, { artifactId: id, userId: alice })).toBeNull();

    await testDb().update(artifacts).set({ ready: false }).where(eq(artifacts.id, id));
    expect(await readOwnedArtifact(testDb(), root, { artifactId: id, userId: alice })).toBeNull();
  });

  it("uses random object keys, not user-supplied names", async () => {
    const alice = await makeUser("Alice");
    await storeArtifact(testDb(), root, {
      userId: alice,
      filename: "../../escape.sh",
      mimeType: "text/plain",
      bytes: new Uint8Array([1]),
    });
    const [row] = await testDb().select().from(artifacts);
    expect(row?.objectKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.filename).toBe(sanitizeFilename("../../escape.sh"));
    expect(row?.filename).not.toContain("/");
  });

  it("serves with private, no-sniff, no-referrer, sandboxed headers", () => {
    const headers = artifactHeaders({ filename: "page.html", mimeType: "text/html", sizeBytes: 10, sha256: "abc" });
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("sandbox");
    // Active content is downloaded, never rendered inline.
    expect(headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(
      artifactHeaders({ filename: "p.png", mimeType: "image/png", sizeBytes: 1, sha256: "a" }).get(
        "Content-Disposition",
      ),
    ).toMatch(/^inline;/);
  });
});
