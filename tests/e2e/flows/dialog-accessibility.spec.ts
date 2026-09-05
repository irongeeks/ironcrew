import { test, expect } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";

test("native company dialog contains keyboard focus, excludes the background, and restores its opener", async ({
  page,
  request,
}, testInfo) => {
  await establishSession(request);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const opener = page.getByTestId("open-vendor-policy");
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Provider-Freigaben", exact: true });
  const heading = dialog.getByRole("heading", { name: "Provider-Freigaben", exact: true });
  await expect(heading).toBeFocused();
  await expect(dialog.getByRole("checkbox", { name: "openai/*", exact: true })).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await heading.focus();
  await page.keyboard.press("Tab");
  const firstControl = dialog.locator(":focus");
  await expect(firstControl).toHaveCount(1);
  const firstTag = await firstControl.evaluate((element) => element.outerHTML);
  await page.keyboard.press("Shift+Tab");
  const close = dialog.getByRole("button", { name: "Schliessen", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await dialog.locator(":focus").evaluate((element) => element.outerHTML)).toBe(firstTag);
  // Programmatic focus cannot pierce the browser's modal inertness either.
  await opener.evaluate((element) => element.focus());
  await expect(opener).not.toBeFocused();
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Enter");
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("accessible-dialog-mobile.png") });
  await close.click();
  await expect(opener).toBeFocused();
});

test("Escape closes only the topmost employee dialog and returns through the organization chart", async ({
  page,
  request,
}) => {
  await establishSession(request);
  await page.goto("/");
  const opener = page.getByTestId("open-org-chart");
  await opener.click();
  const organization = page.getByRole("dialog", { name: "Organigramm", exact: true });
  const employee = organization.locator('[data-testid^="org-agent-"]').first();
  await expect(employee).toBeVisible();
  await employee.click();
  // The two native dialogs remain mounted; only the most recently opened one
  // is exposed as interactive by the browser. No fixtures/polyfills are used.
  await expect(page.locator("dialog[open]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(employee).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(opener).toBeFocused();
});
