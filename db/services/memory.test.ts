import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { memoryDreamLeases, memoryItems, settings } from "../schema";
import {
  consolidateMemory,
  correctMemory,
  type Dreamer,
  dreamDue,
  forgetAllMemory,
  forgetMemory,
  listMemory,
  looksSecret,
  memoryHash,
  recallFacts,
  saveMemory,
  searchMemory,
} from "./memory";

async function save(userId: string, content: string, kind: "fact" | "note" = "note") {
  const saved = await saveMemory(testDb(), userId, {
    content,
    tier: kind,
    origin: kind === "fact" ? "explicit" : "inferred",
    eveSessionId: "wrun_test",
    channel: "imessage",
  });
  if (!saved.ok) throw new Error(saved.error);
  return saved.item;
}

const rawRow = async (id: string) => (await testDb().select().from(memoryItems).where(eq(memoryItems.id, id)))[0];

describe("memory", () => {
  beforeEach(resetDb);

  it("persists facts and notes with provenance and finds them by keyword in a later session", async () => {
    const ada = await makeUser("Ada");
    const fact = await save(ada, "Her sister Maya's birthday is March 3.", "fact");
    await save(ada, "Ordered an oat milk cortado at Sightglass.");

    // A fresh query (as a new conversation would) still finds both, with stemming ("birthdays" → "birthday").
    expect((await searchMemory(testDb(), ada, "Maya birthdays")).map((m) => m.content)).toEqual([
      "Her sister Maya's birthday is March 3.",
    ]);
    expect((await searchMemory(testDb(), ada, "coffee cortado"))[0]?.content).toContain("cortado");
    expect((await recallFacts(testDb(), ada)).map((m) => m.id)).toEqual([fact.id]);
    expect(await rawRow(fact.id)).toMatchObject({
      origin: "explicit",
      tier: "fact",
      eveSessionId: "wrun_test",
      channel: "imessage",
    });
  });

  it("dedupes identical text and refuses secrets", async () => {
    const ada = await makeUser("Ada");
    const first = await save(ada, "Prefers aisle seats.", "fact");
    const again = await saveMemory(testDb(), ada, {
      content: "  prefers AISLE seats ",
      tier: "fact",
      origin: "explicit",
    });
    expect(again).toMatchObject({ ok: true, duplicate: true, item: { id: first.id } });
    for (const secret of ["My password is hunter2", "card 4242 4242 4242 4242", `key sk-${"ant-"}${"x".repeat(24)}`]) {
      expect(looksSecret(secret)).toBe(true);
      expect((await saveMemory(testDb(), ada, { content: secret, tier: "fact", origin: "explicit" })).ok).toBe(false);
    }
    expect(looksSecret("Call +1 415 555 0100 after 6pm")).toBe(false);
  });

  it("never shows, forgets, or corrects another person's memory", async () => {
    const ada = await makeUser("Ada");
    const bo = await makeUser("Bo");
    const adas = await save(ada, "Allergic to peanuts.", "fact");
    await save(bo, "Allergic to shellfish.", "fact");

    expect((await searchMemory(testDb(), bo, "allergic peanuts")).map((m) => m.content)).toEqual([
      "Allergic to shellfish.",
    ]);
    expect((await recallFacts(testDb(), bo)).map((m) => m.content)).toEqual(["Allergic to shellfish."]);
    expect(await forgetMemory(testDb(), bo, adas.id)).toBe(0);
    expect((await correctMemory(testDb(), bo, adas.id, "Not allergic.")).ok).toBe(false);
    expect(await forgetAllMemory(testDb(), bo)).toBe(1);
    expect((await rawRow(adas.id))?.content).toBe("Allergic to peanuts.");
  });

  it("corrects a fact: the old text is erased and the new one is an explicit fact pointing at it", async () => {
    const ada = await makeUser("Ada");
    const wrong = await save(ada, "Lives in Oakland.", "fact");
    const fixed = await correctMemory(testDb(), ada, wrong.id, "Lives in Berkeley.");
    expect(fixed).toMatchObject({
      ok: true,
      item: { origin: "explicit", content: "Lives in Berkeley.", sourceIds: [] },
    });
    expect(await rawRow(wrong.id)).toMatchObject({ status: "forgotten", content: null });
    expect((await searchMemory(testDb(), ada, "Oakland")).length).toBe(0);
  });

  it("consolidates notes into facts once, even when the pass is repeated or runs concurrently", async () => {
    const ada = await makeUser("Ada");
    const n1 = await save(ada, "Asked for vegetarian options at dinner.");
    const n2 = await save(ada, "Said she hasn't eaten meat in years.");
    const n3 = await save(ada, "Wanted the 6:40 ferry today.");
    let calls = 0;
    const dream: Dreamer = async ({ notes }) => {
      calls++;
      expect(notes.map((n) => n.id)).toEqual([n1.id, n2.id, n3.id]);
      return { facts: [{ content: "Is vegetarian.", sources: [n1.id, n2.id], replaces: [] }] };
    };

    const [a, b] = await Promise.all([
      consolidateMemory(testDb(), ada, dream),
      consolidateMemory(testDb(), ada, dream),
    ]);
    expect([a.added, b.added].sort()).toEqual([0, 1]);
    expect(await consolidateMemory(testDb(), ada, dream)).toEqual({ notes: 0, added: 0, superseded: 0, rejected: 0 });
    expect(calls).toBe(1);

    const { facts, notes } = await listMemory(testDb(), ada);
    expect(facts).toMatchObject([{ content: "Is vegetarian.", origin: "inferred", sourceIds: [n1.id, n2.id] }]);
    expect(notes.every((n) => n.status === "consolidated")).toBe(true);
    // Consolidated notes stay searchable as a dated log.
    expect((await searchMemory(testDb(), ada, "ferry"))[0]?.id).toBe(n3.id);
  });

  it("lets dreaming replace inferred facts but never explicit ones, and rejects ungrounded facts", async () => {
    const ada = await makeUser("Ada");
    const explicit = await save(ada, "Works at the library.", "fact");
    const first = await save(ada, "Prefers window seats.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Prefers window seats.", sources: [first.id], replaces: [] }],
    }));
    const inferred = (await recallFacts(testDb(), ada)).find((f) => f.origin === "inferred");
    const update = await save(ada, "Now books aisle seats for long flights.");
    const result = await consolidateMemory(testDb(), ada, async () => ({
      facts: [
        {
          content: "Prefers aisle seats on long flights.",
          sources: [update.id],
          replaces: [inferred?.id ?? "", explicit.id],
        },
        { content: "Made-up fact.", sources: ["00000000-0000-0000-0000-000000000000"], replaces: [] },
        { content: "Has no sources.", sources: [], replaces: [] },
      ],
    }));
    expect(result).toEqual({ notes: 1, added: 1, superseded: 1, rejected: 2 });
    expect((await recallFacts(testDb(), ada)).map((f) => f.content).sort()).toEqual([
      "Prefers aisle seats on long flights.",
      "Works at the library.",
    ]);
  });

  it("keeps forgotten memories forgotten through consolidation", async () => {
    const ada = await makeUser("Ada");
    // 1. A note forgotten while the model is running cannot feed a fact.
    const note = await save(ada, "Is planning a surprise party for Sam.");
    const kept = await save(ada, "Walks the dog at 7am.");
    const r1 = await consolidateMemory(testDb(), ada, async () => {
      await forgetMemory(testDb(), ada, note.id);
      return {
        facts: [
          { content: "Planning a surprise party for Sam.", sources: [note.id], replaces: [] },
          { content: "Walks the dog every morning at 7.", sources: [kept.id], replaces: [] },
        ],
      };
    });
    expect(r1).toMatchObject({ added: 0, rejected: 2 });
    // A changed input invalidates the entire proposal, including uncited paraphrases.
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Walks the dog every morning at 7.", sources: [kept.id], replaces: [] }],
    }));

    // 2. Forgetting a dreamed fact also erases the notes it came from, so search can't surface them.
    const dreamed = (await recallFacts(testDb(), ada))[0];
    expect(dreamed?.content).toBe("Walks the dog every morning at 7.");
    expect(await forgetMemory(testDb(), ada, dreamed?.id ?? "")).toBe(2);
    expect(await searchMemory(testDb(), ada, "dog")).toEqual([]);
    expect(await rawRow(kept.id)).toMatchObject({ status: "forgotten", content: null });

    // 3. Pidge can't re-learn the same text on its own later; the person saying it again still works.
    const later = await save(ada, "Mentioned the dog walk again.");
    const r2 = await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "walks the dog every morning at 7", sources: [later.id], replaces: [] }],
    }));
    expect(r2).toMatchObject({ added: 0, rejected: 1 });
    expect(
      (
        await saveMemory(testDb(), ada, {
          content: "Walks the dog every morning at 7.",
          tier: "note",
          origin: "inferred",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await saveMemory(testDb(), ada, {
          content: "Walks the dog every morning at 7.",
          tier: "fact",
          origin: "explicit",
        })
      ).ok,
    ).toBe(true);

    // 4. Forget everything leaves no readable text.
    await forgetAllMemory(testDb(), ada);
    const rows = await testDb().select().from(memoryItems).where(eq(memoryItems.userId, ada));
    expect(rows.every((r) => r.status === "forgotten" && r.content === null)).toBe(true);
  });

  it("dreams only for people whose local time is 3 a.m., each with their own notes", async () => {
    const ada = await makeUser("Ada");
    const bo = await makeUser("Bo");
    await testDb().update(settings).set({ timezone: "America/Los_Angeles" }).where(eq(settings.userId, ada));
    await testDb().update(settings).set({ timezone: "Asia/Tokyo" }).where(eq(settings.userId, bo));
    await save(ada, "Ada note.");
    await save(bo, "Bo note.");
    const seen: Record<string, string[]> = {};
    const dreamerFor =
      async (userId: string): Promise<Dreamer> =>
      async ({ notes }) => {
        seen[userId] = notes.map((n) => n.content);
        return { facts: [] };
      };
    // 11:17 UTC = 3:17 a.m. in Los Angeles (PST), 8:17 p.m. in Tokyo.
    expect(await dreamDue(testDb(), dreamerFor, new Date("2026-11-24T11:17:00Z"))).toEqual([ada]);
    expect(seen).toEqual({ [ada]: ["Ada note."] });
    expect((await listMemory(testDb(), bo)).notes[0]?.status).toBe("active");
  });
});

describe("memory review regressions", () => {
  beforeEach(resetDb);

  it("erases the complete provenance component, including old sources and sibling facts, within one user", async () => {
    const ada = await makeUser("Ada");
    const bo = await makeUser("Bo");
    const original = await save(ada, "Enjoys coffee and tea.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [
        { content: "Enjoys coffee.", sources: [original.id], replaces: [] },
        { content: "Enjoys tea.", sources: [original.id], replaces: [] },
      ],
    }));
    const old = (await searchMemory(testDb(), ada, "coffee", { tier: "fact" }))[0];
    const update = await save(ada, "Now prefers decaf.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Prefers decaf coffee.", sources: [update.id], replaces: [old?.id ?? ""] }],
    }));
    const latest = (await searchMemory(testDb(), ada, "decaf", { tier: "fact" }))[0];
    await save(bo, "Enjoys coffee.", "fact");
    expect(await forgetMemory(testDb(), ada, latest?.id ?? "")).toBe(5);
    expect(await searchMemory(testDb(), ada, "")).toEqual([]);
    expect(await recallFacts(testDb(), bo)).toHaveLength(1);
    expect(
      (await testDb().select().from(memoryItems).where(eq(memoryItems.userId, ada))).every(
        (row) => row.content === null,
      ),
    ).toBe(true);
  });

  it("promotes user-confirmed duplicate facts and detaches their inferred sources", async () => {
    const ada = await makeUser("Ada");
    const note = await save(ada, "Lives in Oakland.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Lives in Oakland.", sources: [note.id], replaces: [] }],
    }));
    const confirmed = await saveMemory(testDb(), ada, {
      content: "Lives in Oakland.",
      tier: "fact",
      origin: "explicit",
      channel: "web",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      duplicate: true,
      item: { origin: "explicit", sourceIds: [], channel: "web" },
    });
    await forgetMemory(testDb(), ada, note.id);
    expect(await recallFacts(testDb(), ada)).toMatchObject([{ origin: "explicit", content: "Lives in Oakland." }]);
  });

  it("rolls back failed corrections and replaces inferred facts even at capacity", async () => {
    const ada = await makeUser("Ada");
    const note = await save(ada, "Prefers the old office.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Prefers the old office.", sources: [note.id], replaces: [] }],
    }));
    const old = (await recallFacts(testDb(), ada))[0];
    for (let i = 0; i < 199; i++) await save(ada, `Synthetic cap fact ${i}.`, "fact");
    const correction = await save(ada, "An observation to correct.");
    expect((await correctMemory(testDb(), ada, correction.id, "Corrected observation.")).ok).toBe(false);
    expect(await rawRow(correction.id)).toMatchObject({ status: "active", content: "An observation to correct." });
    const update = await save(ada, "Prefers the new office now.");
    expect(
      await consolidateMemory(testDb(), ada, async () => ({
        facts: [
          { content: "Prefers the new office.", sources: [update.id], replaces: [old?.id ?? ""] },
          { content: "New unrelated fact.", sources: [correction.id], replaces: [] },
        ],
      })),
    ).toMatchObject({ added: 1, superseded: 1, rejected: 1 });
    expect(await rawRow(update.id)).toMatchObject({ status: "consolidated" });
    expect(await rawRow(correction.id)).toMatchObject({ status: "active" });
    expect(await recallFacts(testDb(), ada, 300)).toHaveLength(200);
  });

  it("serializes concurrent capacity checks and deduplicates at the database boundary", async () => {
    const ada = await makeUser("Ada");
    for (let i = 0; i < 199; i++) await save(ada, `Synthetic fact ${i}.`, "fact");
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveMemory(testDb(), ada, { content: `Concurrent fact ${i}.`, tier: "fact", origin: "explicit" }),
      ),
    );
    expect(saved.filter((r) => r.ok)).toHaveLength(1);
    expect(await recallFacts(testDb(), ada, 300)).toHaveLength(200);
    const bo = await makeUser("Bo");
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        saveMemory(testDb(), bo, { content: "Same fact.", tier: "fact", origin: "explicit" }),
      ),
    );
    expect(duplicates.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    const item = (await recallFacts(testDb(), bo))[0];
    await expect(
      testDb()
        .insert(memoryItems)
        .values({
          userId: bo,
          content: "Same fact.",
          tier: "fact",
          origin: "explicit",
          contentHash: memoryHash("Same fact."),
        }),
    ).rejects.toThrow();
    expect(item).toBeDefined();
  });

  it("claims dreaming before model work and retries safely after failures or a lost lease", async () => {
    const ada = await makeUser("Ada");
    const note = await save(ada, "Enjoys the ferry.");
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const dream = vi.fn(async () => {
      started();
      await gate;
      return { facts: [{ content: "Enjoys ferries.", sources: [note.id], replaces: [] }] };
    });
    const first = consolidateMemory(testDb(), ada, dream);
    await entered;
    await Promise.all(Array.from({ length: 7 }, () => consolidateMemory(testDb(), ada, dream)));
    expect(dream).toHaveBeenCalledOnce();
    release();
    expect(await first).toMatchObject({ added: 1 });
    const newNote = await save(ada, "Likes another ferry.");
    await expect(
      consolidateMemory(testDb(), ada, async () => {
        throw new Error("model unavailable");
      }),
    ).rejects.toThrow("model unavailable");
    expect(await rawRow(newNote.id)).toMatchObject({ status: "active" });
    expect(await testDb().select().from(memoryDreamLeases)).toEqual([]);
    await testDb()
      .insert(memoryDreamLeases)
      .values({ userId: ada, token: crypto.randomUUID(), expiresAt: new Date(0) });
    expect(await consolidateMemory(testDb(), ada, async () => ({ facts: [] }))).toMatchObject({ notes: 1 });
  });

  it("invalidates paraphrased proposals when any source or replacement changed during generation", async () => {
    const ada = await makeUser("Ada");
    const original = await save(ada, "Works at the old office.");
    await consolidateMemory(testDb(), ada, async () => ({
      facts: [{ content: "Lives near the old office.", sources: [original.id], replaces: [] }],
    }));
    const old = (await recallFacts(testDb(), ada))[0];
    const fresh = await save(ada, "Mentioned work again.");
    expect(
      await consolidateMemory(testDb(), ada, async () => {
        await forgetMemory(testDb(), ada, old?.id ?? "");
        return { facts: [{ content: "Works near the old office.", sources: [fresh.id], replaces: [] }] };
      }),
    ).toMatchObject({ added: 0, rejected: 1, notes: 0 });
    expect(await recallFacts(testDb(), ada)).toEqual([]);
    expect(await rawRow(fresh.id)).toMatchObject({ status: "active" });
  });

  it("counts pending notes outside the first page and permits paging to them", async () => {
    const ada = await makeUser("Ada");
    const pending = await save(ada, "Old pending note.");
    await testDb()
      .insert(memoryItems)
      .values(
        Array.from({ length: 101 }, (_, i) => ({
          userId: ada,
          content: `Newer note ${i}.`,
          tier: "note" as const,
          origin: "inferred" as const,
          status: "consolidated" as const,
          contentHash: memoryHash(`Newer note ${i}.`),
          createdAt: new Date(Date.now() + i + 1000),
        })),
      );
    expect(await listMemory(testDb(), ada)).toMatchObject({ pending: 1 });
    expect((await listMemory(testDb(), ada, 100)).notes.map((m) => m.id)).toContain(pending.id);
    expect((await searchMemory(testDb(), ada, "Old pending"))[0]?.id).toBe(pending.id);
  });

  it("refuses common Google and Stripe key shapes", async () => {
    const ada = await makeUser("Ada");
    for (const key of [`AIzaSy${"A".repeat(33)}`, `sk_live_${"A".repeat(24)}`, `rk_test_${"A".repeat(24)}`]) {
      expect(looksSecret(key)).toBe(true);
      expect((await saveMemory(testDb(), ada, { content: `Uses ${key}.`, tier: "note", origin: "inferred" })).ok).toBe(
        false,
      );
    }
  });
});

it("bounds dream proposals and refuses a stale model result after its lease expires", async () => {
  await resetDb();
  const ada = await makeUser("Ada");
  const note = await save(ada, "Enjoys the ferry.");
  await expect(
    consolidateMemory(testDb(), ada, async () => ({
      facts: Array.from({ length: 21 }, () => ({
        content: "Enjoys ferries.",
        sources: [note.id],
        replaces: [],
      })),
    })),
  ).rejects.toThrow("exceeds bounds");
  expect(await rawRow(note.id)).toMatchObject({ status: "active" });
  expect(
    await consolidateMemory(testDb(), ada, async () => {
      await testDb()
        .update(memoryDreamLeases)
        .set({ expiresAt: new Date(0) })
        .where(eq(memoryDreamLeases.userId, ada));
      return { facts: [{ content: "Enjoys ferries.", sources: [note.id], replaces: [] }] };
    }),
  ).toMatchObject({ added: 0, notes: 0 });
  expect(await rawRow(note.id)).toMatchObject({ status: "active" });
});
