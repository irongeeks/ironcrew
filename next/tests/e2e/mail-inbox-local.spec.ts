import { test, expect } from "@playwright/test";
test("actual backend stores a disabled mailbox policy from the mobile UI without contacting a provider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  await page.goto("/settings/channels");
  const inbox = page.getByRole("region", { name: "E-Mail-Eingang", exact: true });
  await expect(inbox).toBeVisible();
  await inbox.getByText("TLS-Postfach einrichten", { exact: true }).click();
  const form = inbox.locator("form").filter({ has: page.getByLabel("IMAP-Server", { exact: true }) });
  const options = await form
    .getByLabel("Bereich", { exact: true })
    .locator("option")
    .evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  await form.getByLabel("Bereich", { exact: true }).selectOption(options.find(Boolean)!);
  await form.getByLabel("IMAP-Server", { exact: true }).fill("mailbox-fixture.invalid");
  await form.getByLabel("Benutzername", { exact: true }).fill("finance-ui@example.invalid");
  await form.getByLabel("Postfachadresse", { exact: true }).fill("finance-ui@example.invalid");
  await form.getByLabel("Proton Share ID", { exact: true }).fill("local-fixture-share");
  await form.getByLabel("Proton Item ID", { exact: true }).fill("local-fixture-item");
  await form.getByRole("button", { name: "Postfach zum Lesen speichern", exact: true }).click();
  await expect(inbox.getByRole("status").filter({ hasText: /^Gespeichert\.$/ })).toHaveText("Gespeichert.");
  await inbox.getByText("Eingangsregel erstellen", { exact: true }).click();
  const policyForm = inbox
    .locator("form")
    .filter({ has: page.getByLabel("Abrufabstand in Sekunden", { exact: true }) });
  await policyForm.getByLabel("Auftragsart für neue Eingänge", { exact: true }).selectOption("finance");
  await policyForm.getByLabel("Freigabe gültig bis", { exact: true }).fill("2027-01-01T12:00");
  await policyForm.getByRole("button", { name: "Eingangsregel speichern", exact: true }).click();
  await expect(inbox.getByText(/Abruf pausiert/)).toBeVisible();
  const response = await page.request.get("/api/v1/mail-inbox"),
    data = await response.json();
  expect(response.status()).toBe(200);
  expect(data.policies.some((p: { enabled: boolean; kind: string }) => !p.enabled && p.kind === "finance")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "docs/test-evidence/mail-inbox-mobile.png", fullPage: true });
});
