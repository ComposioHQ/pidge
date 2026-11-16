import { describe, expect, it } from "vitest";
import { EnvironmentError, parseEnv } from "./env";

const valid = {
  APP_URL: "https://pidge.example",
  BETTER_AUTH_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://u:p@localhost/db",
  COMPOSIO_API_KEY: "ak_secret_value",
  IMESSAGE_PROJECT_ID: "proj",
  IMESSAGE_PROJECT_SECRET: "photon_secret_value",
  IMESSAGE_WEBHOOK_SECRET: "whsec_value",
  AI_GATEWAY_API_KEY: "gw_secret_value",
  ARTIFACT_STORAGE_DIR: "/var/lib/pidge/artifacts",
};

describe("parseEnv", () => {
  it("accepts a complete configuration and applies defaults", () => {
    const parsed = parseEnv({ ...valid, COMPOSIO_TOOLKIT_DENYLIST: " Gmail, slack ,," });
    expect(parsed.PIDGE_DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(parsed.COMPOSIO_TOOLKIT_DENYLIST).toEqual(["gmail", "slack"]);
    expect(parsed.COMPOSIO_TOOLKIT_ALLOWLIST).toBeUndefined();
  });

  it("keeps an explicitly empty allowlist distinct from an unset one", () => {
    expect(parseEnv({ ...valid, COMPOSIO_TOOLKIT_ALLOWLIST: "" }).COMPOSIO_TOOLKIT_ALLOWLIST).toEqual([]);
  });

  it("fails clearly, naming every missing variable without echoing secret values", () => {
    const { COMPOSIO_API_KEY: _a, IMESSAGE_WEBHOOK_SECRET: _b, ...partial } = valid;
    let error: unknown;
    try {
      parseEnv({ ...partial, BETTER_AUTH_SECRET: "too-short-secret-value" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvironmentError);
    const message = (error as Error).message;
    for (const name of ["COMPOSIO_API_KEY", "IMESSAGE_WEBHOOK_SECRET", "BETTER_AUTH_SECRET"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("too-short-secret-value");
    expect(message).not.toContain("photon_secret_value");
  });
});
