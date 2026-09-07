import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
}
test.describe("Real local browser workflows (SQLite, no mocked API)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 10000 });
  test("website plan, five concepts, selection, build, pins, human review and acceptance", async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    await page.goto("/orders");
    await page.getByRole("button", { name: "Neuer Auftrag", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const goal = `Lokale Website-Abnahme ${Date.now()}`;
    await dialog.getByLabel("Ziel & gewünschtes Ergebnis").fill(goal);
    await dialog.getByLabel("Ablauf", { exact: true }).selectOption("website");
    const employees = (await (await page.request.get("/api/v1/employees")).json()).items;
    await dialog
      .getByRole("combobox", { name: "Lead", exact: true })
      .selectOption(employees.find((e: { seedKey: string }) => e.seedKey === "software").id);
    await dialog
      .getByLabel("Abnahmekriterien (eins je Zeile)")
      .fill("Mobil bedienbar\nFunktionsfähig\nGestaltung geprüft");
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/orders") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Auftrag anlegen", exact: true }).click();
    const created = await responsePromise;
    expect(created.status()).toBe(200);
    const order = await created.json();
    await expect(dialog).not.toBeVisible();
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByRole("heading", { name: goal, exact: true })).toBeVisible();
    await page.getByText("Arbeitsplan festlegen", { exact: true }).click();
    await page
      .getByLabel("Arbeitsschritte (einer je Zeile)")
      .fill("Fünf Richtungen ausarbeiten\nRichtung auswählen\nArtefakt bauen\nPrüfen und abnehmen");
    await page.getByRole("button", { name: "Neue Planversion speichern", exact: true }).click();
    await expect
      .poll(async () => (await (await page.request.get(`/api/v1/orders/${order.id}`)).json()).status)
      .toBe("ready");
    await page
      .getByLabel("Zielgruppe, Inhalt & Gestaltung")
      .fill("Lokale Browser-Testsite: klare Typografie, fünf getrennte visuelle Richtungen, keine externen Inhalte.");
    await page.getByRole("button", { name: "Briefing speichern", exact: true }).click();
    await page.getByText("Ausgearbeitete Konzepte hinterlegen", { exact: true }).click();
    await expect(page.getByLabel("Anzahl Varianten")).toHaveValue("5");
    const palettes = ["#8d5e35", "#315a61", "#4c6650", "#74515c", "#555a68"];
    for (let i = 0; i < 5; i++) {
      const fieldset = page.getByRole("group", { name: `Richtung ${i + 1}`, exact: true });
      await fieldset
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(`Richtung ${i + 1}: ${["Werkstatt", "Klarheit", "Atelier", "Editorial", "Präzision"][i]}`);
      await fieldset
        .getByLabel("Gestalterische Begründung")
        .fill(`Eigenständige Variante ${i + 1} mit Farbe ${palettes[i]} und überprüfbarer Navigation.`);
      await fieldset
        .getByRole("textbox", { name: "HTML", exact: true })
        .fill(
          `<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prüfsite ${i + 1}</title><style>body{font:18px system-ui;margin:0;color:white;background:${palettes[i]};padding:24px}a{color:white;padding:12px;display:inline-block}main{max-width:800px}h1{overflow-wrap:anywhere}</style><main><h1 id="hero">Richtung ${i + 1}</h1><p>Lokale, tatsächlich gebaute HTML-Version.</p><a href="#kontakt">Kontakt</a><section id="kontakt"><h2>Kontakt</h2><p>Nur lokale Testdaten.</p></section></main></html>`,
        );
    }
    await page.getByRole("button", { name: "Konzepte versionieren", exact: true }).click();
    await expect(page.getByRole("button", { name: "Diese Richtung auswählen", exact: true })).toHaveCount(5);
    await expect(
      page
        .frameLocator('iframe[title="Konzeptvorschau: Richtung 3: Atelier"]')
        .getByRole("heading", { name: "Richtung 3", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Diese Richtung auswählen", exact: true }).nth(2).click();
    await page.getByRole("button", { name: "Ausgewählte Website bauen", exact: true }).click();
    await expect(page.getByText("Versionsgebundenes Feedback", { exact: true })).toBeVisible();
    const site = await (await page.request.get(`/api/v1/orders/${order.id}/workflow`)).json();
    expect(site.artifactVersionId).toBeTruthy();
    expect(site.state).toBe("built");
    const download = page.getByRole("link", { name: "Vollständiges Websitepaket herunterladen", exact: true });
    await expect(download).toHaveAttribute("href", `/api/v1/artifacts/${site.artifactVersionId}/package`);
    const packaged = await page.request.get((await download.getAttribute("href"))!);
    expect(packaged.status()).toBe(200);
    expect(packaged.headers()["content-type"]).toContain("application/gzip");
    expect((await packaged.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    await expect(
      page.frameLocator('iframe[title="Website-Vorschau"]').getByRole("heading", { name: "Richtung 3", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Mobil", exact: true }).click();
    await page.getByRole("button", { name: "Stelle in Vorschau markieren", exact: true }).click();
    await page
      .getByRole("button", { name: "Markierung in der Vorschau", exact: true })
      .click({ position: { x: 80, y: 65 } });
    await expect(page.getByLabel("Elementanker (z. B. #hero)")).toHaveValue("viewport-point:80,65");
    await page.getByLabel("Kommentar", { exact: true }).fill("Mobile Hauptüberschrift prüfen.");
    await page.getByRole("button", { name: "Feedback speichern", exact: true }).click();
    await expect(page.getByText("Mobile Hauptüberschrift prüfen.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Gesammeltes Feedback zur Umsetzung geben", exact: true }).click();
    await page
      .getByLabel("Nachweis der Nachbesserung")
      .fill("Richtung 3 bei 390px geprüft; Überschrift bricht ohne Überlauf um.");
    await page.getByRole("button", { name: "Feedback als geprüft erledigen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Feedback als geprüft erledigen", exact: true })).toHaveCount(0);
    await page.getByText("Manuelle Prüfung protokollieren", { exact: true }).click();
    for (const label of ["Mobile Bedienung", "Funktion", "Qualität"]) {
      await page
        .getByRole("textbox", { name: `${label} · Prüfbeleg` })
        .fill(
          `Lokaler Browsernachweis ${label}: Version ${site.artifactVersionId}, Inhaltsanker und Darstellung geprüft.`,
        );
      await page.getByRole("checkbox", { name: `${label} · bestanden` }).check();
    }
    await page.getByRole("button", { name: "Prüfung speichern", exact: true }).click();
    await page.getByRole("button", { name: "Diese Version abnehmen", exact: true }).click();
    await expect
      .poll(async () => (await (await page.request.get(`/api/v1/orders/${order.id}/workflow`)).json()).state)
      .toBe("accepted");
    const reviews = (await (await page.request.get(`/api/v1/orders/${order.id}/reviews`)).json()).items;
    expect(reviews.at(-1).actor).toBe("human");
    await page.reload();
    await expect(page.getByText("FACHABLAUF / Abgenommen", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Mobil", exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Website-Vorschau"]').getByRole("heading", { name: "Richtung 3", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "apps/web/evidence/website-local-accepted.png", fullPage: true });
  });
  test("company configuration, explicit zero budget, profile edits and setup continuation persist", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await login(page);
    await page.goto("/settings/models");
    await expect(page.getByRole("checkbox", { name: "Live-Ausführung ausdrücklich aktivieren" })).not.toBeChecked();
    await page.getByRole("button", { name: "Modellzugang speichern", exact: true }).click();
    await expect
      .poll(async () => (await (await page.request.get("/api/v1/configuration")).json()).liveExecutionEnabled)
      .toBe(false);
    await expect(page.getByLabel("Entfernter Build-Worker (Geräte-ID, optional)", { exact: true })).toBeVisible();
    await page.screenshot({ path: "docs/test-evidence/model-execution-settings-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "docs/test-evidence/model-execution-settings-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/settings/budget");
    await page.getByLabel("Limit in USD", { exact: true }).fill("0");
    await page.getByLabel("Zeitraum von", { exact: true }).fill("2026-09-01");
    await page.getByLabel("Zeitraum bis", { exact: true }).fill("2026-10-01");
    await page.getByRole("button", { name: "Budgetzeitraum festlegen", exact: true }).click();
    await expect(page.getByText("Gespeichert.", { exact: true })).toBeVisible();
    expect((await (await page.request.get("/api/v1/budget")).json()).limitUsdMicros).toBe("0");
    const employees = (await (await page.request.get("/api/v1/employees")).json()).items;
    const karla = employees.find((e: { seedKey: string }) => e.seedKey === "research");
    await page.goto(`/crew/${karla.id}`);
    await page
      .getByLabel("Umgangston & Persona", { exact: true })
      .fill("Neugierig, quellenkritisch und klar. Lokaler Browsertest.");
    await page.getByRole("button", { name: "Profil speichern", exact: true }).click();
    await expect(page.getByText("Profil gespeichert.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Umgangston & Persona", { exact: true })).toHaveValue(
      "Neugierig, quellenkritisch und klar. Lokaler Browsertest.",
    );
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Bereit für dein Hauptquartier", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /Den tatsächlichen Stand/ }).check();
    await page.getByRole("button", { name: "Hauptquartier öffnen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  });
});

test("real local finance snapshot shows partial balances, direction, source and verified original download", async ({
  page,
}) => {
  const { createHash, randomUUID } = await import("node:crypto");
  await login(page);
  const session = await (await page.request.get("/api/v1/session")).json();
  const company = await (await page.request.get("/api/v1/company")).json();
  const areas = await (await page.request.get("/api/v1/areas")).json();
  const scope = { companyId: company.id, areaId: areas.items[0].id };
  const post = (url: string, data: unknown) =>
    page.request.post(`/api/v1${url}`, {
      headers: { "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() },
      data,
    });
  const created = await post("/orders", {
    scope,
    kind: "finance",
    goal: "Lokaler Finanzbrowsernachweis",
    budgetLimitUsdMicros: "0",
    acceptanceCriteria: ["Quelle und Original stimmen überein"],
  });
  expect(created.status()).toBe(200);
  const order = await created.json();
  const invoice = {
    id: `browser-finance-${randomUUID()}`,
    supplierId: "local-fixture-vendor",
    reference: "BROWSER-PARTIAL-2026",
    direction: "payable",
    currency: "EUR",
    totalMinor: "12345",
    paidMinor: "2345",
    dueAt: "2026-09-01T00:00:00Z",
    observedAt: "2026-09-07T08:00:00Z",
    source: "local-browser-fixture:verified-pdf",
    disputed: false,
    paymentPause: false,
  };
  const original = Buffer.from("%PDF-1.7\nLocal browser fixture original bytes\n%%EOF");
  const voucherResult = await post(`/orders/${order.id}/finance/vouchers`, {
    invoice,
    originalBase64: original.toString("base64"),
    originalSha256: createHash("sha256").update(original).digest("hex"),
    mediaType: "application/pdf",
  });
  expect(voucherResult.status()).toBe(200);
  const snapshot = await post("/finance/snapshot", { invoices: [invoice] });
  expect(snapshot.status()).toBe(200);
  await page.goto("/finance");
  const metric = page.getByRole("article", { name: "Kennzahlen EUR" });
  await expect(metric.getByText("Verbindlichkeiten offen").locator("..")).toContainText("100,00");
  await expect(metric.getByText("Erfasste Zahlungen").locator("..")).toContainText("23,45");
  await expect(page.getByText(invoice.source, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bankstand nicht verfügbar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beleg im Auftrag öffnen" })).toHaveAttribute(
    "href",
    `/orders/${order.id}?tab=overview`,
  );
  const originalUrl = await page.getByRole("link", { name: "Originalbeleg herunterladen" }).getAttribute("href");
  expect(originalUrl).toBeTruthy();
  const downloaded = await page.request.get(originalUrl!);
  expect(downloaded.status()).toBe(200);
  expect(downloaded.headers()["content-disposition"]).toContain("attachment");
  expect(await downloaded.body()).toEqual(original);
  await page.screenshot({ path: "apps/web/evidence/finance-local.png", fullPage: true });
});
