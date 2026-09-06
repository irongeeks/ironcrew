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
    const content = page.getByRole("main");
    await expect(content.getByRole("heading", { name: "Unified Operations Center", exact: true })).toBeVisible();
    // The route is lazy-loaded, then its data loads before these sections render.
    for (const name of ["Session Stream", "Node Grid", "Alert Feed"]) {
      await expect(content.getByRole("heading", { name, exact: true })).toBeVisible();
    }
  });

  test("stats API returns data", async ({ request }) => {
    const res = await request.get("/api/stats");
    expect(res.ok()).toBeTruthy();
    const stats = await res.json();
    expect(stats).toBeTruthy();
  });
});
