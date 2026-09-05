import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Isolated from the functional suite: screenshots always start with a fresh,
// local test company, never an operator's database or provider accounts.
export default defineConfig({
  ...base,
  testDir: "tests/docs",
  projects: [{ name: "documentation", use: { viewport: { width: 1920, height: 1080 } } }],
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:8810",
    locale: "de-DE",
    reducedMotion: "reduce",
    trace: "on",
  },
  outputDir: "test-results/docs",
  retries: 0,
  webServer: {
    ...base.webServer,
    command: "pnpm dev:e2e",
    url: "http://127.0.0.1:8810",
    reuseExistingServer: false,
    env: { PORT: "8790", UPDATE_CHECK_ENABLED: "0", IRONCREW_INSTALL_TYPE: "source" },
  },
});
