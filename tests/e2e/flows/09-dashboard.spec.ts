import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

// The standalone Dashboard view was folded into the Office Mission Control
// layout in v2.5.0. Metrics and quick actions now live on the home Office
// tab rather than a dedicated "STATS" tab. These specs are skipped until
// they are rewritten against the new layout.
test.describe.skip("Dashboard Flow", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("dashboard loads with metrics and sections", async ({ page }) => {
    await navigateTo(page, "dashboard");
    const content = page.locator("main, [class*=dashboard], [class*=Dashboard]").first();
    await expect(content).toBeVisible();
    // Instead of looking for [class*=card], look for the dashboard stats text
    const statsText = page.getByText(/AGENTEN|ABGESCHLOSSEN|SERVER|agents|completed/i).first();
    await expect(statsText).toBeVisible();
  });

  test("quick actions navigate to correct views", async ({ page }) => {
    await navigateTo(page, "dashboard");

    const quickAction = page.getByRole("button", { name: /create|new|add/i }).first();
    // If the quick action button does not exist, skip the test explicitly
    const quickActionVisible = await quickAction.isVisible().catch(() => false);
    test.skip(!quickActionVisible, "No quick action buttons present on dashboard");

    await quickAction.click();
    // Verify that either a modal opened or URL changed
    const modalOrNav = page.locator("[role=dialog], .modal").first();
    const modalVisible = await modalOrNav.isVisible().catch(() => false);
    const urlChanged = !page.url().includes("dashboard");
    expect(modalVisible || urlChanged).toBeTruthy();
  });
});
