import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Operations Center Flow", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("operations view loads with all sections", async ({ page }) => {
    await navigateTo(page, "operations");
    const content = page.locator("main, [class*=operations], [class*=Operations]").first();
    await expect(content).toBeVisible();
    const sections = page.locator("section, [class*=section], [class*=Section], [class*=card], [class*=Card]");
    const count = await sections.count();
    expect(count).toBeGreaterThan(0);
  });

  test("stats API returns data", async ({ request }) => {
    const res = await request.get("/api/stats");
    expect(res.ok()).toBeTruthy();
    const stats = await res.json();
    expect(stats).toBeTruthy();
  });
});
