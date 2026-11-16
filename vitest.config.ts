import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "spike/**", ".eve/**", ".next/**", ".output/**"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/env.ts"],
    // Tests share one migrated database; run files serially so table resets never race.
    fileParallelism: false,
  },
});
