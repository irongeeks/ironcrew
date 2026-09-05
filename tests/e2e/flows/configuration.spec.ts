import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { CompanyConfigurationSnapshot } from "../../../src/shared/company-configuration";

const endpoint = "/api/crew/configuration";
const cleanups = new Map<string, (request: APIRequestContext) => Promise<void>>();
const snapshot = async (request: APIRequestContext) =>
  expectOkJson<CompanyConfigurationSnapshot>(await request.get(endpoint), "Read company configuration");

test.afterEach(async ({ request }, testInfo) => {
  const cleanup = cleanups.get(testInfo.testId);
  cleanups.delete(testInfo.testId);
  await cleanup?.(request);
});

test("owner configuration persists with audit and stale-write protection on desktop and mobile", async ({
  page,
  request,
}, testInfo) => {
  const headers = { "x-csrf-token": await establishSession(request) };
  const before = await snapshot(request);
  cleanups.set(testInfo.testId, async (request) => {
    const current = await snapshot(request);
    await expectOkJson(
      await request.put(endpoint, {
        headers,
        data: {
          baseRevision: current.revision,
          reason: "Restore original configuration after browser test",
          configuration: before.configuration,
        },
      }),
      "Restore company configuration",
    );
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("open-configuration").click();
  const panel = page.getByRole("region", { name: "Firmenkonfiguration", exact: true });
  const heading = panel.getByRole("heading", { name: "Firmenkonfiguration", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Maximale parallele Runs", { exact: true })).toBeEnabled();
  await expect(heading).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("configuration-desktop.png") });

  const concurrency = before.configuration.runtime.maxConcurrentRuns === 64 ? 63 : 64;
  await panel.getByLabel("Maximale parallele Runs", { exact: true }).fill(String(concurrency));
  await panel.getByRole("button", { name: "Memory", exact: true }).click();
  const contextEntries = before.configuration.memory.maxContextEntries === 5 ? 6 : 5;
  await panel.getByLabel("Maximale Kontext-Einträge", { exact: true }).fill(String(contextEntries));
  const reason = "Runtime- und Memory-Grenzen für dokumentierten Browsertest setzen";
  await panel.getByLabel("Begründung der Änderung", { exact: true }).fill(reason);
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === endpoint && item.request().method() === "PUT",
  );
  await panel.getByRole("button", { name: "Konfiguration speichern", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(panel.getByRole("status").filter({ hasText: "Konfiguration gespeichert" })).toBeVisible();
  const saved = await snapshot(request);
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.configuration.runtime.maxConcurrentRuns).toBe(concurrency);
  expect(saved.configuration.memory.maxContextEntries).toBe(contextEntries);
  expect(saved.history[0].reason).toBe(reason);
  expect(saved.history[0].auditEventId).toBeTruthy();
  const stale = await request.put(endpoint, {
    headers,
    data: {
      baseRevision: before.revision,
      reason: "Stale browser write must not replace current configuration",
      configuration: before.configuration,
    },
  });
  expect(stale.status()).toBe(409);
  expect((await snapshot(request)).revision).toBe(saved.revision);

  await page.reload();
  await page.getByTestId("open-configuration").click();
  await expect(panel.getByLabel("Maximale parallele Runs", { exact: true })).toHaveValue(String(concurrency));
  await panel.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(panel.getByLabel("Maximale Kontext-Einträge", { exact: true })).toHaveValue(String(contextEntries));
  await panel.getByRole("button", { name: "Freigaben", exact: true }).click();
  await panel.getByText(/^Immer freigabepflichtig \(/).click();
  await expect(panel.getByText("bank_transfer", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "bank_transfer", exact: true })).toHaveCount(0);
  await panel.getByText(/^Änderungsverlauf \(/).click();
  await panel.getByText(reason, { exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByText(reason, { exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("configuration-history.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Laufzeiten", exact: true }).click();
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport();
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const grid = panel.locator(".configuration-grid");
  expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const limits = await Promise.all([
    panel.getByLabel("Maximale parallele Runs", { exact: true }).boundingBox(),
    panel.getByLabel("Maximale Laufzeit (Sekunden)", { exact: true }).boundingBox(),
  ]);
  expect(limits[1]!.y).toBeGreaterThan(limits[0]!.y + limits[0]!.height);
  await page.screenshot({ path: testInfo.outputPath("configuration-mobile.png") });
});
