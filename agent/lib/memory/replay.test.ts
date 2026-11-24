import { beforeEach, describe, expect, it } from "vitest";
import { forgetMemory, saveMemory } from "../../../db/services/memory";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { webPrincipal } from "../identity/principal";
import { memoryScope, pidgeMemory } from "./provider";

// Deliberately exercise pinned Eve 0.83.3 internals: callbacks alone cannot prove replay behavior.
const root = new URL("./", import.meta.resolve("eve"));
const internals = (path: string) => import(new URL(path, root).href);
const { ContextContainer, contextStorage } = await internals("context/container.js");
const { SessionKey, SessionIdKey, AuthKey, StaticModelReferenceKey } = await internals("context/keys.js");
const { ContextKey } = await internals("context/key.js");
const {
  prepareMemoryPreamble,
  dispatchMemoryTurnStarted,
  drainMemoryCommit,
  prepareMemoryCompaction,
  dispatchMemoryCompactionCompleted,
} = await internals("context/memory-lifecycle.js");

type DurableContext = { entries(): Iterable<[{ name: string }, unknown]>; set(key: unknown, value: unknown): void };
function fresh(userId: string) {
  const ctx = new ContextContainer();
  const auth = webPrincipal(userId);
  ctx.set(StaticModelReferenceKey, null);
  ctx.set(SessionIdKey, "replay-session");
  ctx.set(AuthKey, auth);
  ctx.set(SessionKey, { sessionId: "replay-session", auth: { current: auth, initiator: auth } });
  return ctx;
}
function restore(ctx: DurableContext) {
  const restored = new ContextContainer();
  // Same JSON boundary as workflow persistence, including date serialization. No shared process cache.
  for (const [key, value] of ctx.entries()) restored.set(new ContextKey(key.name), JSON.parse(JSON.stringify(value)));
  return restored;
}
const definition = {
  slot: "memory",
  logicalPath: "memory.ts",
  provider: pidgeMemory,
  scope: memoryScope,
  namespace: "replay-test",
  visibility: "scope",
};
async function recall(ctx: unknown, phase: "turn" | "compaction", history: unknown[] = [], state = {}, sequence = 1) {
  return contextStorage.run(ctx, async () => {
    const event = {
      type: phase === "turn" ? "turn.started" : "compaction.completed",
      data: { turnId: "replay-turn", sequence, stepIndex: 1, modelId: "test" },
    };
    const args = { appRoot: process.cwd(), ctx, event, memories: [definition], nodeId: "__root__", messages: history };
    if (phase === "turn") {
      prepareMemoryPreamble(ctx, { history, state, input: [{ role: "user", content: "Denver flight" }] });
      await dispatchMemoryTurnStarted(args);
    } else {
      prepareMemoryCompaction(ctx, { history, state });
      await dispatchMemoryCompactionCompleted(args);
    }
    return drainMemoryCommit(ctx);
  });
}

describe("memory through Eve replay", () => {
  beforeEach(resetDb);

  it.each(["turn", "compaction"] as const)(
    "reuses operation-scoped %s recall after crash and memory mutation",
    async (phase) => {
      const ada = await makeUser("Ada");
      await saveMemory(testDb(), ada, { content: "Prefers aisle seats.", tier: "fact", origin: "explicit" });
      const ctx = fresh(ada);
      // Establish the turn lock required by Eve's compaction path.
      const turn = await recall(ctx, "turn");
      const first = phase === "turn" ? turn : await recall(ctx, "compaction", turn.recalledMessages, turn.state);
      const persisted = restore(ctx);
      await saveMemory(testDb(), ada, { content: "Likes Denver.", tier: "fact", origin: "explicit" });
      const replayed = await recall(persisted, phase, JSON.parse(JSON.stringify(first.recalledMessages)), first.state);
      expect(replayed.recalledMessages).toEqual([]);
      // A genuinely new operation sees the new memory.
      const next = await recall(restore(persisted), "turn", first.recalledMessages, first.state, 2);
      expect(JSON.stringify(next.recalledMessages)).toContain("Likes Denver.");
    },
  );

  it("keeps no plaintext in the replay cache and fails closed if a recalled memory was forgotten", async () => {
    const ada = await makeUser("Ada");
    const saved = await saveMemory(testDb(), ada, {
      content: "Has a synthetic preference.",
      tier: "fact",
      origin: "explicit",
    });
    if (!saved.ok) throw new Error(saved.error);
    const ctx = fresh(ada);
    const first = await recall(ctx, "turn");
    const cache = [...ctx.entries()].find(([key]: [{ name: string }]) => key.name === "pidge.memory.recall");
    expect(JSON.stringify(cache)).not.toContain("Has a synthetic preference.");
    await forgetMemory(testDb(), ada, saved.item.id);
    await expect(recall(restore(ctx), "turn", first.recalledMessages, first.state)).rejects.toThrow("was forgotten");
    const next = await recall(restore(ctx), "turn", first.recalledMessages, first.state, 2);
    expect(JSON.stringify(next.recalledMessages)).not.toContain("Has a synthetic preference.");
  });
});
