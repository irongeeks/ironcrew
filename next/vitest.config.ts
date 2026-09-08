import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Limit concurrent SQLite/fsync, Argon2 and TLS fixtures on Windows runners.
    maxWorkers: process.platform === "win32" ? 2 : 4,
  },
});
