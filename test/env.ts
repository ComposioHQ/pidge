import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DATABASE_URL } from "./urls";

// Deterministic, non-secret values so modules that read the validated environment work under test.
Object.assign(process.env, {
  APP_URL: "https://pidge.test",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
  DATABASE_URL: TEST_DATABASE_URL,
  COMPOSIO_API_KEY: "test-composio-key",
  IMESSAGE_PROJECT_ID: "test-project",
  IMESSAGE_PROJECT_SECRET: "test-project-secret",
  IMESSAGE_WEBHOOK_SECRET: "test-webhook-secret",
  AI_GATEWAY_API_KEY: "test-gateway-key",
  ARTIFACT_STORAGE_DIR: join(tmpdir(), "pidge-test-artifacts"),
});
