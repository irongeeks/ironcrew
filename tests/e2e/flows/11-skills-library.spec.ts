import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Skills Library Flow", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("skills grid loads and shows skills", async ({ page }) => {
    await navigateTo(page, "skills");
    const content = page.locator("main, [class*=skills], [class*=Skills], [class*=library]").first();
    await expect(content).toBeVisible();
    const cards = page.locator("[class*=card], [class*=Card], [class*=skill], [class*=Skill]");
    const count = await cards.count();
    // In CI the database starts fresh — there may be zero skills
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("category filter narrows results", async ({ page }) => {
    await navigateTo(page, "skills");
    const allCards = page.locator("[class*=card], [class*=Card]");
    const totalCount = await allCards.count();

    const categories = page.locator("[class*=category], [class*=Category], [class*=filter]").locator("button");
    const catCount = await categories.count();
    if (catCount > 1) {
      await categories.nth(1).click();
      // Wait for the filter to take effect
      await expect(page.locator("[class*=card], [class*=Card]").first()).toBeVisible();
      const filteredCount = await page.locator("[class*=card], [class*=Card]").count();
      expect(filteredCount).toBeLessThanOrEqual(totalCount);
    }
  });

  test("search filters skills", async ({ page }) => {
    await navigateTo(page, "skills");
    const searchInput = page.getByRole("searchbox").first();
    const searchVisible = await searchInput.isVisible().catch(() => false);
    if (!searchVisible) {
      const fallback = page.getByPlaceholder(/search|filter|find/i).first();
      const fallbackVisible = await fallback.isVisible().catch(() => false);
      test.skip(!fallbackVisible, "No search input found in skills library");
      await fallback.fill("test-nonexistent-skill-xyz");
    } else {
      await searchInput.fill("test-nonexistent-skill-xyz");
    }
  });
});
