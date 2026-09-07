import { test, expect } from "@playwright/test";
const id = "55555555-5555-4555-8555-555555555555";
test("explicit hosting-care browser fixture records USD and exact patch policy without enabling dispatch by default", async ({
  page,
}) => {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", (route) => {
    const req = route.request(),
      p = new URL(req.url()).pathname.replace("/api/v1", "");
    if (req.method() === "POST") {
      writes.push(req.postDataJSON());
      return route.fulfill({ json: { id } });
    }
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "fixture", setupRequired: false },
      "/setup": { step: 8, data: {} },
      "/company": { id, name: "Explicit care UI fixture", revision: 1 },
      "/employees": { items: [] },
      "/areas": { items: [] },
      "/configuration": { connections: [] },
      "/mandates": { items: [{ id, version: 2, allowedToolIds: [] }] },
      "/hosting/profiles": {
        items: [
          {
            id,
            scope: { companyId: id, areaId: id },
            name: "Care fixture",
            stack: "static",
            publicUrl: "https://fixture.invalid",
            monthlyCostLimitUsdMicros: "1000000",
          },
        ],
      },
      [`/orders/${id}`]: {
        id,
        goal: "Care UI fixture",
        kind: "website",
        status: "completed",
        scope: { companyId: id, areaId: id },
        acceptanceCriteria: [],
        revision: 1,
        budgetLimitUsdMicros: "0",
      },
      [`/orders/${id}/workflow`]: { state: "published", concepts: [], artifactVersionId: id },
      [`/orders/${id}/hosting`]: {
        profiles: [
          {
            id,
            name: "Care fixture",
            orderId: id,
            stack: "static",
            publicUrl: "https://fixture.invalid",
            monthlyCostLimitUsdMicros: "1000000",
          },
        ],
        deployments: [{ id, profileId: id, artifactVersionId: id, state: "verified" }],
      },
      [`/orders/${id}/website-care`]: { policies: [], states: [], jobs: [] },
    };
    return route.fulfill({ json: data[p] ?? { items: [] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orders/${id}`);
  await page.getByText("Hosting und Veröffentlichung", { exact: true }).click();
  await page.getByLabel("Hostingprofil für diesen Auftrag", { exact: true }).selectOption(id);
  await page.getByText("Mandat für dieses Hostingziel erstellen", { exact: true }).click();
  await expect(page.getByLabel("website.care.check", { exact: true })).toBeVisible();
  await expect(page.getByLabel("website.care.backup", { exact: true })).toBeVisible();
  await expect(page.getByLabel("website.care.update", { exact: true })).toBeVisible();
  await page.getByText("Hosting und Veröffentlichung", { exact: true }).click();
  await page.getByText("Betreuungsmandat einrichten", { exact: true }).click();
  await page.getByLabel("Technisches Mandat (care.check/backup/update)", { exact: true }).selectOption(id);
  await page.getByLabel("Mandat gültig bis", { exact: true }).fill("2026-12-01T12:00");
  await page.getByLabel("Gesamtrahmen in USD", { exact: true }).fill("12,345678");
  await page.getByLabel("Vorfallbudget in USD", { exact: true }).fill("2");
  await page.getByLabel("Freigegebene Sicherungsziel-ID beim Hostingbroker", { exact: true }).fill("approved-backups");
  await page.getByLabel("Öffentlicher age-Empfänger", { exact: true }).fill("age1" + "a".repeat(58));
  await page.getByLabel("Bestätigte Backupkosten in USD", { exact: true }).fill("0.001");
  await page.getByLabel("Eine konkrete Patchversion mit Rückweg freigeben", { exact: true }).check();
  await page.getByLabel("Aktuelle Laufzeitversion", { exact: true }).fill("1.0.0");
  await page.getByLabel("Aktueller Manifest-SHA256", { exact: true }).fill("a".repeat(64));
  await page.getByLabel("Neue Patchversion", { exact: true }).fill("1.0.1");
  await page.getByLabel("Neuer Manifest-SHA256", { exact: true }).fill("b".repeat(64));
  await page.getByLabel("Bestätigte Updatekosten in USD", { exact: true }).fill("0,25");
  await expect(page.getByLabel("Diese genaue technische Betreuung aktivieren", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Betreuungsmandat bestätigen", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    enabled: false,
    mandateId: id,
    mandateVersion: 2,
    budgetLimitUsdMicros: "12345678",
    incidentBudgetLimitUsdMicros: "2000000",
    backup: { costUsdMicros: "1000" },
    update: { windowMinutes: 30, candidate: { costUsdMicros: "250000", manifestSha256: "b".repeat(64) } },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
