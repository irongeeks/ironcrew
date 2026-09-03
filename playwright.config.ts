import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: process.env.PW_BASE_URL ?? "http://127.0.0.1:8810",
    // Some environments (containers, CI images) ship a preinstalled Chromium
    // but not the chrome-headless-shell build a pinned Playwright expects.
    // PW_CHROMIUM_PATH points the runner at the browser that is actually there;
    // unset, Playwright resolves its own download as usual.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "flows",
      testMatch: "**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:8810",
      },
      timeout: 60_000,
    },
  ],
  webServer: {
    command: "pnpm dev:e2e",
    url: "http://127.0.0.1:8810",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  retries: process.env.CI ? 1 : 0,
});
