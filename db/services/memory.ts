import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { memoryItems, settings } from "../schema";

/** Longest single memory, after whitespace is collapsed. */
export const MEMORY_TEXT_MAX = 500;
/** Most active facts one person may have; facts are recalled every turn, so this bounds prompt size. */
export const MAX_ACTIVE_FACTS = 200;
/** Most unconsolidated notes; dreaming drains them nightly. */
export const MAX_ACTIVE_NOTES = 500;
/** Facts recalled at the start of every turn (explicit first, then newest). */
export const RECALL_FACTS = 40;
/** Notes dreaming reads per person per run, oldest first. */
export const DREAM_BATCH = 50;
/** Local hour dreaming runs for each person. */
export const DREAM_HOUR = 3;
/** People dreamed per hourly tick. */
export const DREAM_USERS_PER_TICK = 25;

export type MemoryItem = typeof memoryItems.$inferSelect;
export type MemoryView = Pick<
  MemoryItem,
  "id" | "tier" | "origin" | "status" | "content" | "channel" | "sourceIds" | "createdAt"
>;
export type Provenance = { eveSessionId?: string | null; channel?: "imessage" | "web" | null };
export type SaveInput = Provenance & {
  content: string;
  tier: "fact" | "note";
  origin: "explicit" | "inferred";
  sourceIds?: string[];
};
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const view = {
  id: memoryItems.id,
  tier: memoryItems.tier,
  origin: memoryItems.origin,
  status: memoryItems.status,
  content: memoryItems.content,
  channel: memoryItems.channel,
  sourceIds: memoryItems.sourceIds,
  createdAt: memoryItems.createdAt,
};

export const normalizeMemory = (text: string) => text.trim().replace(/\s+/g, " ");

/** Case-, spacing- and punctuation-insensitive identity of a memory's text. */
export function memoryHash(text: string): string {
  const key = normalizeMemory(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
  return createHash("sha256").update(key).digest("hex");
}

const SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passcode|passwd|pin|one[- ]time code|otp|2fa code|verification code|security code|cvv|api key|secret key|access token|bearer|ssn|social security)\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

function luhnCard(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (digits.length >= 13 && sum % 10 === 0) return true;
  }
  return false;
}

/** Secrets are refused, never stored (spec §12). Deliberately broad: a refused harmless phrase costs less than a leak. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text)) || luhnCard(text);
}

function validate(content: string): Result<{ text: string }> {
  const text = normalizeMemory(content);
  if (!text) return { ok: false, error: "Nothing to remember." };
  if (text.length > MEMORY_TEXT_MAX)
    return { ok: false, error: `Keep each memory under ${MEMORY_TEXT_MAX} characters.` };
  if (looksSecret(text)) {
    return { ok: false, error: "That looks like a password, code, key, or card number. Pidge doesn't store secrets." };
  }
  return { ok: true, text };
}

async function isForgotten(db: Database | Tx, userId: string, hash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.contentHash, hash), eq(memoryItems.status, "forgotten")))
    .limit(1);
  return Boolean(row);
}

async function insertMemory(
  db: Database | Tx,
  userId: string,
  input: SaveInput,
): Promise<Result<{ item: MemoryView; duplicate: boolean }>> {
  const valid = validate(input.content);
  if (!valid.ok) return valid;
  const hash = memoryHash(valid.text);
  // ponytail: exact-text tombstones; a reworded version of a forgotten fact can still be re-inferred.
  if (input.origin === "inferred" && (await isForgotten(db, userId, hash))) {
    return {
      ok: false,
      error: "The person asked Pidge to forget this, so it won't be re-learned without them saying so.",
    };
  }
  const [existing] = await db
    .select(view)
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, userId),
        eq(memoryItems.tier, input.tier),
        eq(memoryItems.status, "active"),
        eq(memoryItems.contentHash, hash),
      ),
    )
    .limit(1);
  if (existing) return { ok: true, item: existing, duplicate: true };
  const [active] = await db
    .select({ n: count() })
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.tier, input.tier), eq(memoryItems.status, "active")));
  const cap = input.tier === "fact" ? MAX_ACTIVE_FACTS : MAX_ACTIVE_NOTES;
  if ((active?.n ?? 0) >= cap) {
    return { ok: false, error: `Memory is full (${cap} ${input.tier}s). Forget some on the Memory page first.` };
  }
  const [item] = await db
    .insert(memoryItems)
    .values({
      userId,
      tier: input.tier,
      origin: input.origin,
      content: valid.text,
      contentHash: hash,
      eveSessionId: input.eveSessionId ?? null,
      channel: input.channel ?? null,
      sourceIds: input.sourceIds ?? [],
    })
    .returning(view);
  if (!item) throw new Error("memory insert returned nothing");
  return { ok: true, item, duplicate: false };
}

/**
 * Saves one memory for this user. Explicit facts are things the person said or entered; inferred notes are Pidge's
 * observations. Secrets are refused, an identical active memory is returned instead of duplicated, and Pidge cannot
 * re-learn on its own (inferred) the exact text of something the person told it to forget.
 */
export function saveMemory(db: Database, userId: string, input: SaveInput) {
  return insertMemory(db, userId, input);
}

/** Active facts recalled every turn: explicit ones first, then newest. */
export async function recallFacts(db: Database, userId: string, limit = RECALL_FACTS): Promise<MemoryView[]> {
  return db
    .select(view)
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.tier, "fact"), eq(memoryItems.status, "active")))
    .orderBy(asc(memoryItems.origin), desc(memoryItems.createdAt))
    .limit(limit);
}

/**
 * Keyword search over this user's active facts and notes (consolidated notes stay searchable, like a dated log).
 * Any matching word counts (English stemming via Postgres full-text search), ranked by relevance then recency; a
 * plain substring match catches names the stemmer misses. An empty query lists the newest.
 */
export async function searchMemory(
  db: Database,
  userId: string,
  query: string,
  options: { limit?: number; tier?: "fact" | "note" } = {},
): Promise<MemoryView[]> {
  const q = normalizeMemory(query).slice(0, 200);
  const tsq = sql`nullif(replace(plainto_tsquery('english', ${q})::text, ' & ', ' | '), '')::tsquery`;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select(view)
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, userId),
        inArray(memoryItems.status, ["active", "consolidated"]),
        options.tier ? eq(memoryItems.tier, options.tier) : undefined,
        q ? sql`(${memoryItems.search} @@ ${tsq} or ${memoryItems.content} ilike ${like})` : undefined,
      ),
    )
    .orderBy(
      q ? sql`ts_rank(${memoryItems.search}, coalesce(${tsq}, ''::tsquery)) desc` : desc(memoryItems.createdAt),
      desc(memoryItems.createdAt),
    )
    .limit(options.limit ?? 10);
}

/** Everything the Memory page shows: active facts and the newest notes. */
export async function listMemory(db: Database, userId: string) {
  const [facts, notes] = await Promise.all([
    db
      .select(view)
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.tier, "fact"), eq(memoryItems.status, "active")))
      .orderBy(desc(memoryItems.createdAt)),
    searchMemory(db, userId, "", { tier: "note", limit: 100 }),
  ]);
  return { facts, notes };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMemoryId = (id: string) => UUID.test(id);
const uuidArray = (ids: string[]) => sql`${`{${ids.filter(isMemoryId).join(",")}}`}::uuid[]`;

/**
 * Forgets rows in one transaction: their text is erased (only the hash stays as a tombstone). Forgetting a fact also
 * forgets the notes and earlier facts it was built from; forgetting a note also forgets facts dreamed from it, so
 * nothing the person removed survives in a consolidated form.
 */
async function forgetIn(tx: Tx, userId: string, ids: string[]): Promise<number> {
  const arr = uuidArray(ids);
  const rows = await tx
    .update(memoryItems)
    .set({ status: "forgotten", content: null, updatedAt: new Date() })
    .where(
      and(
        eq(memoryItems.userId, userId),
        sql`${memoryItems.status} <> 'forgotten'`,
        sql`(${memoryItems.id} = any(${arr})
          or ${memoryItems.id} = any(select unnest(m.source_ids) from memory_items m where m.user_id = ${userId} and m.id = any(${arr}))
          or ${memoryItems.sourceIds} && ${arr})`,
      ),
    )
    .returning({ id: memoryItems.id });
  return rows.length;
}

/** Forgets one of this user's memories. Returns how many rows were erased (0 when the ID isn't theirs). */
export function forgetMemory(db: Database, userId: string, id: string): Promise<number> {
  if (!isMemoryId(id)) return Promise.resolve(0);
  return db.transaction((tx) => forgetIn(tx, userId, [id]));
}

/** Forgets every memory this user has. */
export async function forgetAllMemory(db: Database, userId: string): Promise<number> {
  const rows = await db
    .update(memoryItems)
    .set({ status: "forgotten", content: null, updatedAt: new Date() })
    .where(and(eq(memoryItems.userId, userId), sql`${memoryItems.status} <> 'forgotten'`))
    .returning({ id: memoryItems.id });
  return rows.length;
}

/** Replaces a wrong memory with the person's corrected text: the old one is forgotten, the new one is an explicit fact. */
export async function correctMemory(
  db: Database,
  userId: string,
  id: string,
  content: string,
  provenance: Provenance = {},
): Promise<Result<{ item: MemoryView }>> {
  if (!isMemoryId(id)) return { ok: false, error: "No such memory." };
  const valid = validate(content);
  if (!valid.ok) return valid;
  return db.transaction(async (tx) => {
    if ((await forgetIn(tx, userId, [id])) === 0) return { ok: false as const, error: "No such memory." };
    const saved = await insertMemory(tx, userId, {
      ...provenance,
      content: valid.text,
      tier: "fact",
      origin: "explicit",
      sourceIds: [id],
    });
    return saved.ok ? { ok: true as const, item: saved.item } : saved;
  });
}

export type DreamInput = {
  facts: { id: string; origin: "explicit" | "inferred"; content: string }[];
  notes: { id: string; content: string; createdAt: Date }[];
};
export type DreamProposal = { facts: { content: string; sources: string[]; replaces: string[] }[] };
export type Dreamer = (input: DreamInput) => Promise<DreamProposal>;
export type DreamResult = { notes: number; added: number; superseded: number; rejected: number };

/**
 * One bounded consolidation ("dreaming") pass for one user: read up to {@link DREAM_BATCH} unconsolidated notes and
 * the current facts, ask `dream` for concise durable facts, then apply in one transaction that re-locks the notes.
 * Repeat-safe: only notes still `active` at apply time are consumed, so a second or concurrent pass over the same
 * notes changes nothing. A proposed fact is kept only when every source is one of those notes, so a note forgotten
 * while the model ran cannot leak in, and exact text the person forgot is never re-learned. Dreaming may replace
 * inferred facts, never explicit ones.
 */
export async function consolidateMemory(db: Database, userId: string, dream: Dreamer): Promise<DreamResult> {
  const result: DreamResult = { notes: 0, added: 0, superseded: 0, rejected: 0 };
  const notes = await db
    .select({ id: memoryItems.id, content: memoryItems.content, createdAt: memoryItems.createdAt })
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.tier, "note"), eq(memoryItems.status, "active")))
    .orderBy(asc(memoryItems.createdAt))
    .limit(DREAM_BATCH);
  if (notes.length === 0) return result;
  const facts = await recallFacts(db, userId, MAX_ACTIVE_FACTS);
  const proposal = await dream({
    facts: facts.map((f) => ({ id: f.id, origin: f.origin, content: f.content ?? "" })),
    notes: notes.map((n) => ({ id: n.id, content: n.content ?? "", createdAt: n.createdAt })),
  });

  return db.transaction(async (tx) => {
    const live = new Set(
      (
        await tx
          .select({ id: memoryItems.id })
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.userId, userId),
              eq(memoryItems.status, "active"),
              inArray(
                memoryItems.id,
                notes.map((n) => n.id),
              ),
            ),
          )
          .for("update")
      ).map((r) => r.id),
    );
    if (live.size === 0) return result;
    const replaceable = new Set(facts.filter((f) => f.origin === "inferred").map((f) => f.id));
    for (const fact of proposal.facts) {
      const replaces = fact.replaces.filter((id) => replaceable.has(id));
      if (fact.sources.length === 0 || !fact.sources.every((id) => live.has(id))) {
        result.rejected++;
        continue;
      }
      const saved = await insertMemory(tx, userId, {
        content: fact.content,
        tier: "fact",
        origin: "inferred",
        sourceIds: [...new Set([...fact.sources, ...replaces])],
      });
      if (!saved.ok || saved.duplicate) {
        result.rejected += saved.ok ? 0 : 1;
        continue;
      }
      result.added++;
      if (replaces.length > 0) {
        const old = await tx
          .update(memoryItems)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(
            and(eq(memoryItems.userId, userId), eq(memoryItems.status, "active"), inArray(memoryItems.id, replaces)),
          )
          .returning({ id: memoryItems.id });
        result.superseded += old.length;
        for (const r of old) replaceable.delete(r.id);
      }
    }
    await tx
      .update(memoryItems)
      .set({ status: "consolidated", updatedAt: new Date() })
      .where(and(eq(memoryItems.userId, userId), inArray(memoryItems.id, [...live])));
    result.notes = live.size;
    return result;
  });
}

/** Whether it is {@link DREAM_HOUR} o'clock for someone in `timeZone`. */
export function isDreamHour(timeZone: string, now: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(hour) === DREAM_HOUR;
}

/**
 * The hourly dreaming tick: consolidate notes for each person whose local time is {@link DREAM_HOUR} a.m. A person
 * whose pass fails is retried the next night; their notes stay active and searchable meanwhile.
 */
export async function dreamDue(
  db: Database,
  dreamerFor: (userId: string) => Promise<Dreamer>,
  now = new Date(),
): Promise<string[]> {
  const pending = await db
    .selectDistinct({ userId: memoryItems.userId, timezone: settings.timezone })
    .from(memoryItems)
    .innerJoin(settings, eq(settings.userId, memoryItems.userId))
    .where(and(eq(memoryItems.tier, "note"), eq(memoryItems.status, "active")));
  const due = pending.filter((p) => isDreamHour(p.timezone, now)).slice(0, DREAM_USERS_PER_TICK);
  for (const { userId } of due) {
    try {
      const result = await consolidateMemory(db, userId, await dreamerFor(userId));
      console.log("pidge.memory_dreamed", { userId, ...result });
    } catch (error) {
      console.error("pidge.memory_dream_failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return due.map((d) => d.userId);
}
