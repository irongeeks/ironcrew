import { randomBytes } from "node:crypto";
import { E2E_BASE_URL, e2eReadyPath } from "./server/config/e2e-isolation.ts";
import { defineConfig, devices } from "@playwright/test";

if (process.env.PW_BASE_URL && process.env.PW_BASE_URL !== E2E_BASE_URL) {
  throw new Error("E2E refuses PW_BASE_URL overrides: tests must use the isolated local server");
}
const runId = process.env.IRONCREW_E2E_RUN_ID ?? randomBytes(16).toString("hex");
process.env.IRONCREW_E2E_RUN_ID = runId;

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: E2E_BASE_URL,
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
        baseURL: E2E_BASE_URL,
      },
      timeout: 60_000,
    },
  ],
  webServer: {
    command: "pnpm dev:e2e",
    url: `${E2E_BASE_URL}${e2eReadyPath(runId)}`,
    env: { IRONCREW_E2E_RUN_ID: runId },
    reuseExistingServer: false,
    timeout: 240_000,
  },
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  retries: process.env.CI ? 1 : 0,
});
