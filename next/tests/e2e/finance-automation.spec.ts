import { test, expect, type Page } from "@playwright/test";
const ids = {
  company: "11111111-1111-4111-8111-111111111111",
  area: "22222222-2222-4222-8222-222222222222",
  order: "33333333-3333-4333-8333-333333333333",
  voucher: "44444444-4444-4444-8444-444444444444",
  target: "55555555-5555-4555-8555-555555555555",
  mandate: "66666666-6666-4666-8666-666666666666",
  rule: "77777777-7777-4777-8777-777777777777",
  reminder: "88888888-8888-4888-8888-888888888888",
};
const scope = { companyId: ids.company, areaId: ids.area };
async function fixture(page: Page) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const rule = {
    id: ids.rule,
    scope,
    state: "proposed",
    supplierId: "supplier-a",
    currency: "EUR",
    minTotalMinor: "12000",
    maxTotalMinor: "12000",
    source: "Explizite UI-Vertragsfixture",
    accountDatevId: 42,
    taxRate: 19,
    sourceVoucherId: ids.voucher,
    targetId: ids.target,
    mandateId: ids.mandate,
    mandateVersion: 3,
    mediaTypes: ["application/pdf"],
    sevdeskSupplierId: 17,
    taxRuleId: "1",
  };
  const automation = {
    processingRules: [{ id: ids.rule, scope, data: rule }],
    reminderPolicies: [] as Record<string, unknown>[],
    statuses: [
      {
        id: "status",
        scope,
        data: { state: "needs_review", reason: "no_matching_processing_rule", at: "2026-09-07T10:00:00Z" },
      },
    ],
    holds: [] as Record<string, unknown>[],
    corrections: [] as Record<string, unknown>[],
  };
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/finance/processing-rules")
        automation.processingRules.push({ id: "new-rule", scope, data: { ...rule, ...body, id: "new-rule" } });
      if (path === "/finance/reminder-policies")
        automation.reminderPolicies.push({ id: ids.reminder, scope, data: { ...body, state: "proposed" } });
      if (path.endsWith("/activate"))
        automation.reminderPolicies = automation.reminderPolicies.map((doc) => ({
          ...doc,
          data: { ...(doc.data as object), state: "active" },
        }));
      if (path === "/finance/invoice-holds") automation.holds = [{ id: "hold", scope, data: body }];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "written", state: "proposed" }),
      });
    }
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "fixture", setupRequired: false },
      "/setup": { step: 8, data: {} },
      "/company": { id: ids.company, name: "Explizite UI-Vertragsfirma", timezone: "Europe/Berlin", revision: 1 },
      "/employees": { items: [] },
      "/areas": { items: [{ id: ids.area, name: "Finanzbereich" }] },
      "/finance": {
        items: [],
        vouchers: [
          {
            id: ids.voucher,
            scope,
            orderId: ids.order,
            originalSha256: "a".repeat(64),
            originalMediaType: "application/pdf",
            invoice: {
              id: "45",
              reference: "Beleg 45",
              supplierId: "supplier-a",
              currency: "EUR",
              totalMinor: "12000",
            },
          },
        ],
      },
      "/finance/automation": automation,
      "/orders": { items: [{ id: ids.order, kind: "finance", scope, goal: "Finanzauftrag für UI-Abnahme" }] },
      "/configuration": {
        connections: [
          {
            id: ids.target,
            label: "sevdesk Finance",
            provider: "sevdesk",
            scope,
            enabledTools: [
              "sevdesk.voucher.upload",
              "sevdesk.voucher.stage",
              "sevdesk.invoice.read",
              "sevdesk.reminder.send",
            ],
          },
          {
            id: "foreign-target",
            label: "Fremder Bereich",
            provider: "sevdesk",
            scope: { ...scope, areaId: "other" },
            enabledTools: ["sevdesk.voucher.upload", "sevdesk.voucher.stage"],
          },
        ],
      },
      "/mandates": {
        items: [
          {
            id: ids.mandate,
            label: "Freigegebener Finanzbereich",
            scope,
            version: 3,
            expiresAt: "2099-01-01T00:00:00Z",
            allowedToolIds: ["sevdesk.voucher.upload", "sevdesk.voucher.stage", "sevdesk.reminder.send"],
            targetIds: [ids.target],
          },
        ],
      },
    };
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data[path] ?? { items: [], nextCursor: null }),
    });
  });
  return { writes, automation };
}
test.describe("finance automation UI contract fixtures, not a provider or finance-lead review", () => {
  test("proposal derives source scope and supplier, restricts targets and never pretends finance review", async ({
    page,
  }) => {
    const { writes } = await fixture(page);
    await page.goto("/finance");
    const panel = page.getByRole("region", { name: "Finanzautomatisierung", exact: true });
    await expect(panel.getByText("Die Prüfung durch Saul steht aus.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Geprüfte Regel als CEO aktivieren" })).toHaveCount(0);
    await panel.getByText("Belegregel aus Original vorschlagen", { exact: true }).click();
    await panel.getByLabel("Originalbeleg für die Regel", { exact: true }).selectOption(ids.voucher);
    const form = panel.locator("form").first();
    await expect(form.getByRole("option", { name: "Fremder Bereich" })).toHaveCount(0);
    await form.getByLabel("sevdesk-Ziel im Bereich", { exact: true }).selectOption(ids.target);
    await form.getByLabel("Gültiges Mandat", { exact: true }).selectOption(`${ids.mandate}:3`);
    await form.getByLabel("sevdesk-Lieferanten-ID", { exact: true }).fill("17");
    await form.getByLabel("DATEV-Konto-ID", { exact: true }).fill("42");
    await form.getByLabel("sevdesk-Steuerregel", { exact: true }).selectOption("1");
    await form.getByLabel("Steuersatz in Prozent", { exact: true }).fill("19");
    await form
      .getByLabel("Begründung und Quelle der Zuordnung", { exact: true })
      .fill("Zuordnung anhand Originalbeleg 45.");
    await panel.screenshot({ path: "docs/test-evidence/finance-rule-ui-fixture.png" });
    await form.getByRole("button", { name: "Regel zur Prüfung vorschlagen" }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      path: "/finance/processing-rules",
      body: {
        scope,
        sourceVoucherId: ids.voucher,
        supplierId: "supplier-a",
        currency: "EUR",
        minTotalMinor: "12000",
        maxTotalMinor: "12000",
        mandateId: ids.mandate,
        mandateVersion: 3,
        targetId: ids.target,
        mediaTypes: ["application/pdf"],
        taxRate: 19,
      },
    });
    expect(writes[0]!.body).not.toHaveProperty("review");
    await expect(panel.getByRole("button", { name: "Geprüfte Regel als CEO aktivieren" })).toHaveCount(0);
  });
  test("exact reminder preview precedes explicit activation and payment pause is separately recorded", async ({
    page,
  }) => {
    const { writes } = await fixture(page);
    await page.goto("/finance");
    const panel = page.getByRole("region", { name: "Finanzautomatisierung", exact: true });
    await panel.getByText("Zahlungserinnerung vorbereiten", { exact: true }).click();
    await panel.getByLabel("Finanzauftrag für Erinnerung", { exact: true }).selectOption(ids.order);
    const form = panel.locator("form").first();
    await form.getByLabel("sevdesk-Ziel im Bereich", { exact: true }).selectOption(ids.target);
    await form.getByLabel("Gültiges Mandat", { exact: true }).selectOption(`${ids.mandate}:3`);
    await form.getByLabel("sevdesk-Rechnungs-ID", { exact: true }).fill("45");
    await form.getByLabel("Genauer Empfänger", { exact: true }).fill("invoice@example.invalid");
    await form.getByLabel("Genauer Betreff", { exact: true }).fill("Zahlungsstand zu Rechnung 45");
    await form
      .getByLabel("Genauer Nachrichtentext", { exact: true })
      .fill("Bitte prüfen Sie den noch offenen Rechnungsbetrag.\nVielen Dank.");
    await form.getByRole("button", { name: "Erinnerung als Vorschlag speichern" }).click();
    const reminder = panel.getByRole("article", { name: "Erinnerung 45" });
    await expect(reminder).toContainText("invoice@example.invalid");
    await expect(reminder).toContainText("Bitte prüfen Sie den noch offenen Rechnungsbetrag.");
    expect(writes).toHaveLength(1);
    await reminder.getByRole("button", { name: "Diesen Empfänger und Text aktivieren" }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({ path: `/finance/reminder-policies/${ids.reminder}/activate`, body: {} });
    await panel.getByText("Zahlungspause oder Widerspruch erfassen", { exact: true }).click();
    await panel.getByLabel("Finanzauftrag für Sperre", { exact: true }).selectOption(ids.order);
    const hold = panel.locator("form").last();
    await hold.getByLabel("sevdesk-Ziel im Bereich", { exact: true }).selectOption(ids.target);
    await hold.getByLabel("Rechnungs-ID für Sperre", { exact: true }).fill("45");
    await hold.getByLabel("Zahlung pausiert", { exact: true }).check();
    await hold
      .getByLabel("Grund und Quelle der Sperre oder Aufhebung", { exact: true })
      .fill("Vereinbarte Zahlungsfrist laut Kundenmail.");
    await hold.getByRole("button", { name: "Sperrstatus speichern" }).click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toMatchObject({
      path: "/finance/invoice-holds",
      body: { scope, targetId: ids.target, invoiceId: "45", paymentPause: true, disputed: false },
    });
  });
  test("review evidence unlocks only CEO activation and mobile English forms remain accessible", async ({ page }) => {
    const { automation, writes } = await fixture(page);
    automation.processingRules[0]!.data = {
      ...automation.processingRules[0]!.data,
      state: "reviewed",
      review: { evidence: "Expliziter gespeicherter Finanzlead-Prüfnachweis für UI-Test" },
    } as (typeof automation.processingRules)[0]["data"];
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/finance");
    await page.getByLabel("Sprache").selectOption("en");
    const panel = page.getByRole("region", { name: "Finance automation", exact: true });
    await expect(panel.getByText(/Expliziter gespeicherter Finanzlead/)).toBeVisible();
    await panel.getByRole("button", { name: "Activate reviewed rule as CEO" }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ path: `/finance/processing-rules/${ids.rule}/activate`, body: {} });
    await panel.getByText("Prepare payment reminder", { exact: true }).click();
    await panel.getByLabel("Finance order for reminder", { exact: true }).selectOption(ids.order);
    await expect(panel.getByLabel("Exact recipient", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({ path: "docs/test-evidence/finance-reminder-mobile-ui-fixture.png", fullPage: true });
  });
});

test("real local application loads finance automation without API interception", async ({ page }) => {
  await page.goto("/finance");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finanzen", exact: true })).toBeVisible();
  await page.goto("/finance");
  const panel = page.getByRole("region", { name: "Finanzautomatisierung", exact: true });
  await expect(panel.getByRole("heading", { name: "Belegregeln und Erinnerungen" })).toBeVisible();
  await expect(panel.getByText("Noch keine Ausführung protokolliert.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    scrollTo(0, 0);
  });
  await page.screenshot({ path: "docs/test-evidence/finance-automation-real-empty.png", fullPage: true });
});

test("classification correction UI sends typed revisions and requires a reviewed state before activation", async ({
  page,
}) => {
  const { writes, automation } = await fixture(page);
  automation.corrections.push({
    id: ids.rule,
    scope,
    data: {
      id: ids.rule,
      scope,
      state: "active",
      field: "accountDatevId",
      value: 42,
      version: 1,
      scopeDescription: "Nur dieser Lieferant im Finanzbereich",
      source: "Explizite Korrektur-UI-Fixture",
      voucherId: ids.voucher,
      binding: { supplierId: "supplier-a", currency: "EUR", mediaType: "application/pdf" },
      review: { evidence: "Expliziter Review-Fixture-Nachweis" },
    },
  });
  await page.goto("/finance");
  const panel = page.getByRole("region", { name: "Wiederverwendbare Zuordnungskorrekturen", exact: true });
  await expect(panel.getByRole("button", { name: "Geprüfte Zuordnungskorrektur aktivieren" })).toHaveCount(0);
  await panel.getByText("Zuordnung für künftige Belege ändern", { exact: true }).click();
  await panel.getByLabel("Neuer Zuordnungswert", { exact: true }).fill("43");
  await panel
    .getByLabel("Begründung der Änderung", { exact: true })
    .fill("Künftige DATEV-Zuordnung laut Originalnachweis");
  await panel.getByRole("button", { name: "Neue Regelversion vorschlagen" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: `/finance/correction-rules/${ids.rule}/revision`,
    body: { value: 43, source: "Künftige DATEV-Zuordnung laut Originalnachweis" },
  });
  (automation.corrections[0].data as Record<string, unknown>).state = "reviewed";
  await page.reload();
  await panel.getByRole("button", { name: "Geprüfte Zuordnungskorrektur aktivieren" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: `/finance/correction-rules/${ids.rule}/activate`, body: {} });
});
