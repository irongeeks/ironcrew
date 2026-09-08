import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Real SQLite migration/reopen fixtures share disk I/O across test files.
    // Bound parallel workers rather than relaxing test or hook deadlines.
    maxWorkers: 2,
    include: ["server/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    setupFiles: ["./server/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage/api",
      include: ["server/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "server/**/*.test.ts",
        "server/**/*.spec.ts",
        // Type-only declaration modules — instrumented but no executable code,
        // suppress reported coverage when included.
        "server/types/**",
        "server/**/types.ts",
        // Declarative pack-hook files (structurally 0% — no runtime branches).
        "server/modules/workflow/packs/video-artifact.ts",
        "server/packs/built-in/*/hooks/**",
      ],
    },
  },
});
