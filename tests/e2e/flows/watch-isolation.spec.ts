import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";

test("generated files in independent workspaces do not reload the application", async ({ page, request }) => {
  await establishSession(request);
  const name = `watch-isolation-${process.env.IRONCREW_E2E_RUN_ID}`;
  const directories = [".tmp", "next/.tmp", "coverage", "test-results"].map((base) => path.resolve(base, name));
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Before</title>");
      await writeFile(path.join(directory, "tsconfig.json"), "{}");
    }
    await page.goto("/");
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute("data-watch-isolation", "preserved"));
    for (const directory of directories) {
      await writeFile(path.join(directory, "index.html"), "<!doctype html><title>After</title>");
      await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    }
    // The watcher batches filesystem events; observe that interval explicitly.
    // No application readiness or network response is replaced by this delay.
    await page.waitForTimeout(1500);
    await expect(page.locator("html")).toHaveAttribute("data-watch-isolation", "preserved");
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});
