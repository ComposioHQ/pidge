import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, resetDb, testDb } from "../../test/db";
import { memoryItems, settings } from "../schema";
import {
  consolidateMemory,
  correctMemory,
  type Dreamer,
  dreamDue,
  forgetAllMemory,
  forgetMemory,
  listMemory,
  looksSecret,
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
    for (const secret of [
      "My password is hunter2",
      "card 4242 4242 4242 4242",
      "key sk-ant-abcdefghijklmnopqrstuv1234",
    ]) {
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
      item: { origin: "explicit", content: "Lives in Berkeley.", sourceIds: [wrong.id] },
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
    expect(calls).toBe(2);

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
    expect(r1).toMatchObject({ added: 1, rejected: 1 });

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
