import { z } from "zod";

/**
 * Runtime configuration contract (spec §16.1, adjusted by docs/decisions.md D1 and D5).
 * Parsed lazily so builds do not need production secrets; the first runtime access fails
 * clearly when a required value is missing or malformed. Error messages name variables, never values.
 */
const csv = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
  );

const schema = z.object({
  APP_URL: z.url(),
  BETTER_AUTH_URL: z.url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  DATABASE_URL: z.string().startsWith("postgres"),
  DATABASE_URL_UNPOOLED: z.string().startsWith("postgres").optional(),
  COMPOSIO_API_KEY: z.string().min(1),
  COMPOSIO_TOOLKIT_ALLOWLIST: csv,
  COMPOSIO_TOOLKIT_DENYLIST: csv,
  IMESSAGE_PROJECT_ID: z.string().min(1),
  IMESSAGE_PROJECT_SECRET: z.string().min(1),
  IMESSAGE_WEBHOOK_SECRET: z.string().min(1),
  AI_GATEWAY_API_KEY: z.string().min(1),
  ARTIFACT_STORAGE_DIR: z.string().startsWith("/", "must be an absolute path"),
  PIDGE_DEFAULT_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5"),
  /** Origin the Next.js server uses to reach its own `/eve/v1/*` routes; defaults to the local Next.js port. */
  EVE_INTERNAL_ORIGIN: z.url().optional(),
  /** Bearer token for `POST /api/notify` (docs/decisions.md D14); unset or empty disables the endpoint. */
  PIDGE_NOTIFY_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export class EnvironmentError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid Pidge environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "EnvironmentError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** Validated process environment. Throws {@link EnvironmentError} on first use if invalid. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Canonical public origin without a trailing slash. */
export function appOrigin(): string {
  return new URL(env().APP_URL).origin;
}
