import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Office View Flow", () => {
  let savedCsrfToken: string | null = null;

  test.beforeEach(async ({ page, request }) => {
    savedCsrfToken = await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test.afterEach(async ({ request }) => {
    // Reset officeWorkflowPack to default after each test — the pack selector test
    // writes a non-default value to settings which would corrupt department lookups
    // in all subsequent tests (departments go to office_pack_departments, not departments).
    if (savedCsrfToken) {
      await request.put("/api/settings", {
        data: { officeWorkflowPack: "development" },
        headers: { "x-csrf-token": savedCsrfToken },
      });
    }
    savedCsrfToken = null;
  });

  test("office canvas renders and is interactive", async ({ page }) => {
    await navigateTo(page, "office");
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 5000 });
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);
  });

  test("clicking department area opens overlay", async ({ page }) => {
    // Pixi.js canvas click interactions are unreliable in headless browsers.
    // The hit-testing depends on WebGL rendering which may not work in CI.
    test.fixme(true, "Pixi.js canvas click-to-overlay is unreliable in headless Chrome");

    await navigateTo(page, "office");
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 5000 });
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await canvas.click({ position: { x: box!.width * 0.25, y: box!.height * 0.4 } });

    const overlay = page.locator("[class*=department], [class*=Department], [role=dialog]").first();
    await expect(overlay).toBeVisible({ timeout: 3000 });

    const closeBtn = page.getByRole("button", { name: /close|×|✕|back/i }).first();
    if (await closeBtn.isVisible()) await closeBtn.click();
  });

  test("office pack selector changes pack", async ({ page }) => {
    await navigateTo(page, "office");
    const packSelector = page.getByRole("combobox").first();
    await expect(packSelector).toBeVisible({ timeout: 3000 });
    await packSelector.selectOption({ index: 1 });
    // Verify the canvas is still rendered after pack change
    await expect(page.locator("canvas").first()).toBeVisible();
  });
});
