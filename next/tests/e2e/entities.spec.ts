import { test, expect } from "@playwright/test";
test("customer/project management and exact order assignment persist through reload", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  await page.goto("/settings/projects");
  const name = `Kunde ${Date.now()}`,
    projectName = `Projekt ${Date.now()}`;
  const c = page.getByRole("form", { name: "Kunde anlegen", exact: true });
  await c.getByLabel("Name", { exact: true }).fill(name);
  await c.getByRole("button", { name: "Kunde anlegen", exact: true }).click();
  const p = page.getByRole("form", { name: "Projekt anlegen", exact: true });
  await p.getByLabel("Name", { exact: true }).fill(projectName);
  await expect(p.getByLabel("Kunde (optional)").locator("option").filter({ hasText: name })).toHaveCount(1);
  await p.getByLabel("Kunde (optional)").selectOption({ label: name });
  await p.getByRole("button", { name: "Projekt anlegen", exact: true }).click();
  await expect(page.locator("summary").filter({ hasText: projectName })).toBeVisible();
  await page.reload();
  await expect(page.locator("summary").filter({ hasText: projectName })).toContainText(name);
  await page.goto("/orders");
  await page.getByRole("button", { name: "Neuer Auftrag", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Ziel & gewünschtes Ergebnis").fill("Kundenbezogener Rechercheauftrag");
  await dialog.getByLabel("Abnahmekriterien (eins je Zeile)").fill("Quellen geprüft");
  await dialog.getByLabel("Kunde (optional)").selectOption({ label: name });
  await dialog.getByLabel("Projekt (optional)").selectOption({ label: projectName });
  const customerId = await dialog.getByLabel("Kunde (optional)").inputValue(),
    projectId = await dialog.getByLabel("Projekt (optional)").inputValue();
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Auftrag anlegen", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const order = await response.json();
  expect(order.scope).toMatchObject({ customerId, projectId });
  const stored = await page.request.get(`/api/v1/orders/${order.id}`);
  expect((await stored.json()).scope).toEqual(order.scope);
});
