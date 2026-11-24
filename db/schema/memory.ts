import { sql } from "drizzle-orm";
import { customType, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Searchable per-user memory (docs/decisions.md D17). `fact` rows are durable and recalled at the start of every
 * turn; `note` rows are dated observations, found only by search, until nightly dreaming condenses them into facts.
 * `origin` separates what the person said or entered (`explicit`) from what Pidge inferred (`inferred`).
 * A forgotten row keeps only its `content_hash`, so dreaming can never re-derive the same text by itself.
 */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tier: text("tier", { enum: ["fact", "note"] }).notNull(),
    origin: text("origin", { enum: ["explicit", "inferred"] }).notNull(),
    /** Notes become `consolidated` once dreaming has read them; replaced inferred facts become `superseded`. */
    status: text("status", { enum: ["active", "consolidated", "superseded", "forgotten"] })
      .notNull()
      .default("active"),
    /** Null once forgotten. */
    content: text("content"),
    contentHash: text("content_hash").notNull(),
    /** Provenance: where it was said (null for the web Memory page and dreaming). */
    eveSessionId: text("eve_session_id"),
    channel: text("channel", { enum: ["imessage", "web"] }),
    /** Provenance for dreamed facts: the notes they came from and any earlier fact they replace. */
    sourceIds: uuid("source_ids").array().notNull().default(sql`'{}'::uuid[]`),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(content, ''))`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_items_user").on(t.userId, t.tier, t.status),
    index("memory_items_search").using("gin", t.search),
  ],
);
