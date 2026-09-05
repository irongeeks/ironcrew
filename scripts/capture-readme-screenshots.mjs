#!/usr/bin/env node
/** Capture current README views with an isolated E2E database and trace.
 * Requires installed dependencies and Playwright Chromium; no running server.
 * Output: test-results/docs. Review images before copying to docs/screenshots.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve("@playwright/test/cli"), "test", "--config", "playwright.docs.config.ts"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
