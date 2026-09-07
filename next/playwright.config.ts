import { defineConfig } from "@playwright/test";
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
