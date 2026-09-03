import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    setupFiles: ["./server/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage/api",
      include: ["server/**/*.ts"],
      exclude: ["**/*.d.ts", "server/**/*.test.ts", "server/**/*.spec.ts"],
    },
  },
});
