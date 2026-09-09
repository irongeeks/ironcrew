import { defineConfig } from "@playwright/test";

// Playwright sets FORCE_COLOR in its child processes. Express a caller's
// NO_COLOR preference using the same variable before those children inherit it.
if (process.env.NO_COLOR !== undefined) {
  process.env.FORCE_COLOR ??= "0";
  delete process.env.NO_COLOR;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:8899", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node scripts/e2e-server.ts",
    url: "http://127.0.0.1:8899/api/v1/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
