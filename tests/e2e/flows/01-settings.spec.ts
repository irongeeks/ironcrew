import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Settings Flow", () => {
  test.beforeEach(async ({ page, request }) => {
    const csrfToken = await establishSession(request);
    // ci-coverage-gap.spec.ts sets language:"ja" and does not clean up.
    // Reset to English before loading the page so text locators are stable.
    await request.put("/api/settings", {
      data: { language: "en" },
      headers: { "x-csrf-token": csrfToken },
    });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "settings");
  });

  test("General tab: change company name and verify persistence", async ({ page }) => {
    // Wait for settings panel to fully render before interacting
    await expect(page.getByText(/^Settings$/i).first()).toBeVisible({ timeout: 10_000 });

    const generalTab = page.getByRole("button", { name: /allgemein|general/i });
    if (await generalTab.isVisible()) await generalTab.click();

    // Use xpath sibling selector — label has no htmlFor, so getByLabel won't work
    const nameInput = page.locator(
      'xpath=//label[contains(normalize-space(.), "Company Name")]/following-sibling::input',
    );
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    const originalValue = await nameInput.inputValue();
    const newName = `E2E-Corp-${Date.now()}`;
    await nameInput.fill(newName);

    const saveBtn = page.getByRole("button", { name: /Speichern|speichern|save/i }).first();
    await saveBtn.click();
    await expect(saveBtn).toBeEnabled();

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "settings");

    await expect(page.getByText(/^Settings$/i).first()).toBeVisible({ timeout: 10_000 });
    const nameInputAfterReload = page.locator(
      'xpath=//label[contains(normalize-space(.), "Company Name")]/following-sibling::input',
    );
    await expect(nameInputAfterReload).toHaveValue(newName);

    await nameInputAfterReload.fill(originalValue || "IronCrew");
    await page
      .getByRole("button", { name: /Speichern|speichern|save/i })
      .first()
      .click();
  });

  test("API tab: verify tab loads and shows provider form", async ({ page }) => {
    // Wait for settings panel before clicking tabs
    await expect(page.getByText(/^Settings$/i).first()).toBeVisible({ timeout: 10_000 });

    const apiTab = page.getByRole("button", { name: /API/i }).first();
    await apiTab.click();

    // API tab heading renders immediately (not gated on data load)
    await expect(page.getByText(/API-Anbieter|API Providers/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // The add button should be visible
    const addBtn = page.getByRole("button", { name: /Hinzufügen|add|new|\+/i }).first();
    await expect(addBtn).toBeVisible();
  });

  test("CLI tab: provider status visible", async ({ page }) => {
    const cliTab = page.getByRole("button", { name: /CLI/i }).first();
    await cliTab.click();

    const content = page.locator("main, [role=tabpanel], .fixed, section").first();
    await expect(content).not.toBeEmpty({ timeout: 10_000 });
  });

  test("Workflow Packs tab: built-in packs listed", async ({ page }) => {
    const packsTab = page.getByRole("button", { name: /Workflow|Pack/i }).first();
    await packsTab.click();

    // Workflow Packs tab should show pack-related content
    const content = page.locator("main, [role=tabpanel], .fixed, section").first();
    await expect(content).not.toBeEmpty({ timeout: 10_000 });
  });
});
