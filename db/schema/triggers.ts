import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const appEventSubscriptions = pgTable(
  "app_event_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull().unique(),
    eveSessionId: text("eve_session_id").notNull(),
    conversation: text("conversation").notNull(),
    handle: text("handle").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    toolkit: text("toolkit").notNull(),
    triggerSlug: text("trigger_slug").notNull(),
    triggerId: text("trigger_id").unique(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    instruction: text("instruction").notNull(),
    status: text("status", { enum: ["creating", "active", "disabled", "removed", "uncertain"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("app_event_subscriptions_user").on(t.userId),
    // Composio creates/upserts one instance per account + type. Never let a second setup redirect an existing one.
    uniqueIndex("app_event_subscriptions_account_type")
      .on(t.connectedAccountId, t.triggerSlug)
      .where(sql`${t.status} <> 'removed'`),
  ],
);

export const appEventRuns = pgTable(
  "app_event_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => appEventSubscriptions.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    eventId: text("event_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status", {
      enum: ["queued", "handing_off", "running", "completed", "failed", "suppressed"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_event_runs_event").on(t.subscriptionId, t.eventId),
    index("app_event_runs_due").on(t.status, t.retryAt),
  ],
);
