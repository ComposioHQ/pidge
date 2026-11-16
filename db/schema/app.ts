import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const userRef = () =>
  uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

/** One row per user; exactly one owner (spec §14 `settings`). */
export const settings = pgTable(
  "settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    model: text("model"),
    timezone: text("timezone").notNull().default("UTC"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("settings_single_owner").on(t.role).where(sql`${t.role} = 'owner'`)],
);

/** Verified channel handle → internal user (spec §7.3). A channel/handle pair is globally unique. */
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    channel: text("channel", { enum: ["imessage"] }).notNull(),
    normalizedHandle: text("normalized_handle").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("channel_identities_handle").on(t.channel, t.normalizedHandle),
    index("channel_identities_user").on(t.userId),
  ],
);

/** Single-use, short-lived identity link tokens. Only the SHA-256 hash is stored. */
export const identityLinkTokens = pgTable(
  "identity_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    channel: text("channel", { enum: ["imessage"] }).notNull(),
    normalizedHandle: text("normalized_handle").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedBy: uuid("consumed_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("identity_link_tokens_handle").on(t.channel, t.normalizedHandle)],
);

/** Eve session ↔ owning user ↔ external conversation (spec §7.4). */
export const conversationBindings = pgTable(
  "conversation_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    eveSessionId: text("eve_session_id").notNull().unique(),
    composioSessionId: text("composio_session_id"),
    channel: text("channel", { enum: ["imessage", "web"] }).notNull(),
    externalConversationId: text("external_conversation_id"),
    /** iMessage destination handle; delivery to this conversation requires a live identity for it (spec §7.3). */
    deliveryHandle: text("delivery_handle"),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_bindings_external")
      .on(t.channel, t.externalConversationId)
      .where(sql`${t.externalConversationId} is not null`),
    index("conversation_bindings_user").on(t.userId),
  ],
);

/** Private artifacts in object storage (spec §14 `artifacts`). */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    eveSessionId: text("eve_session_id"),
    browserTaskId: uuid("browser_task_id"),
    objectKey: text("object_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    ready: boolean("ready").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_user").on(t.userId)],
);

/** Sanitized action audit (spec §14 `action_audit`): metadata only, never arguments or results. */
export const actionAudit = pgTable(
  "action_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    eveSessionId: text("eve_session_id").notNull(),
    toolSlug: text("tool_slug").notNull(),
    risk: text("risk").notNull(),
    approval: text("approval", { enum: ["required", "not_required"] }).notNull(),
    outcome: text("outcome", { enum: ["completed", "failed", "blocked", "denied", "error"] }).notNull(),
    composioLogId: text("composio_log_id"),
    createdAt: createdAt(),
  },
  (t) => [index("action_audit_user").on(t.userId, t.createdAt)],
);

/**
 * One row per Composio call that needed approval, keyed by eve call ID (spec §9.6). `boot_id` is the eve process that
 * parked the approval; `status` becomes `started` just before the single provider request. A call whose approval
 * was parked by another process, or that already started, is never executed again after a restart.
 */
export const approvalGuards = pgTable("approval_guards", {
  callId: text("call_id").primaryKey(),
  userId: userRef(),
  eveSessionId: text("eve_session_id").notNull(),
  bootId: text("boot_id").notNull(),
  status: text("status", { enum: ["parked", "started"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Explicit, non-secret personal fields the person maintains (spec §12 "Personal info"). */
export const personalInfo = pgTable("personal_info", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  email: text("email"),
  phone: text("phone"),
  homeArea: text("home_area"),
  updatedAt: updatedAt(),
});

/**
 * One browser errand (an eve `run_browser` task) owned by one user and conversation (spec §14 `browser_tasks`,
 * adapted to Composio `browser_tool` by D5). Remote task and browser-session IDs live on `browser_task_runs`.
 */
export const browserTasks = pgTable(
  "browser_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    eveSessionId: text("eve_session_id").notNull(),
    composioSessionId: text("composio_session_id"),
    status: text("status", { enum: ["running", "completed", "failed", "stopped"] }).notNull(),
    summary: text("summary").notNull(),
    outcome: text("outcome"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("browser_tasks_user").on(t.userId, t.createdAt)],
);

/**
 * Each remote `BROWSER_TOOL_CREATE_TASK` for an errand: the first run, corrections (stop + new task), and committing
 * runs (spec §14 `browser_task_steps`). `request_key` makes a start idempotent per eve call: a replayed step never
 * creates a second remote task.
 */
export const browserTaskRuns = pgTable(
  "browser_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    browserTaskId: uuid("browser_task_id")
      .notNull()
      .references(() => browserTasks.id, { onDelete: "cascade" }),
    userId: userRef(),
    requestKey: text("request_key").notNull().unique(),
    mode: text("mode", { enum: ["research", "commit"] }).notNull(),
    remoteTaskId: text("remote_task_id").unique(),
    remoteBrowserSessionId: text("remote_browser_session_id"),
    status: text("status", {
      enum: ["starting", "running", "finished", "failed", "stopped", "superseded", "ambiguous"],
    }).notNull(),
    instantCharge: text("instant_charge"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("browser_task_runs_task").on(t.browserTaskId)],
);

/**
 * Application-managed schedules (spec §13.1, §14 `scheduled_jobs`). The timezone is copied from the creator's
 * settings when the schedule is created, so later timezone changes don't silently move an existing schedule.
 * `next_run_at` is null once a one-time schedule has fired.
 */
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    /** Originating conversation: reports go back to this Eve session's iMessage thread (spec §8.3). */
    eveSessionId: text("eve_session_id").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    deliveryHandle: text("delivery_handle").notNull(),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    kind: text("kind", { enum: ["once", "interval", "recurring"] }).notNull(),
    /** `recurring`: 5-field cron evaluated in `timezone`. */
    cron: text("cron"),
    /** `interval`: elapsed minutes between runs. */
    everyMinutes: integer("every_minutes"),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduled_jobs_user").on(t.userId), index("scheduled_jobs_due").on(t.enabled, t.nextRunAt)],
);

/**
 * One occurrence of a schedule (spec §14 `scheduled_runs`). `(job_id, scheduled_for)` is unique, so overlapping
 * dispatcher ticks cannot create the same occurrence twice. Status flow:
 * `leased` (claimed, report not yet accepted) → `reporting` (the reporting turn started) → `completed` | `failed`;
 * `suppressed` when the destination was unlinked or the schedule was paused or cancelled before delivery.
 */
export const scheduledRuns = pgTable(
  "scheduled_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: "cascade" }),
    userId: userRef(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["leased", "reporting", "completed", "failed", "suppressed"] }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    outcome: text("outcome"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("scheduled_runs_occurrence").on(t.jobId, t.scheduledFor),
    index("scheduled_runs_status").on(t.status, t.leaseExpiresAt),
  ],
);
