import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
test("fresh local setup performs real configuration and preserves each step without credential metadata", async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-setup-browser-")),
    repo = await Repository.open(path.join(directory, "company.sqlite")),
    server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createApp({ repo, directory, publicOrigin: origin, webDirectory: path.resolve("dist/web") }));
  try {
    const token = await issueSetupToken(directory);
    await page.goto(origin + "/setup");
    await page.getByLabel("Einmaliges Setup-Token", { exact: true }).fill(token);
    await page.getByLabel("Dein Name", { exact: true }).fill("Actual Local CEO");
    await page.getByLabel("Firmenname", { exact: true }).fill("Fresh onboarding evidence");
    await page.getByLabel("Passwort (mindestens 12 Zeichen)", { exact: true }).fill("local-onboarding-password");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Deine Crew", exact: true })).toBeVisible();
    let progress = await (await page.request.get(origin + "/api/v1/setup")).json();
    expect(progress.data).not.toHaveProperty("password");
    expect(JSON.stringify(progress)).not.toContain("local-onboarding-password");
    const crew = page.getByRole("region", { name: "Crewprofile einrichten", exact: true });
    await expect(crew.locator("details")).toHaveCount(9);
    await crew.getByText("Cersei Lannister", { exact: true }).click();
    const first = crew.locator("details").first();
    await first.getByLabel("Anzeigename", { exact: true }).fill("Cersei – Setup geprüft");
    await first.getByRole("button", { name: "Crewprofil speichern" }).click();
    await expect(page.getByRole("status")).toContainText("Änderung gespeichert");
    await page.reload();
    await expect(crew.getByText("Cersei – Setup geprüft", { exact: true })).toBeVisible();
    await page.getByLabel("Crew und mitgelieferte Logos geprüft.", { exact: true }).check();
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Modelle & Zugang", exact: true })).toBeVisible();
    await page.getByLabel("Proton Pass · Share ID", { exact: true }).fill("ordinary-unsaved-reference-draft");
    await page.getByRole("button", { name: "Zurück", exact: true }).click();
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByLabel("Proton Pass · Share ID", { exact: true })).toHaveValue(
      "ordinary-unsaved-reference-draft",
    );
    await page.getByLabel("Modellzugang fortsetzen", { exact: true }).selectOption("configured");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Modellzugang fehlt");
    await page
      .getByLabel("Installiertes pass-cli Programm (absoluter Pfad)", { exact: true })
      .fill("/nonexistent/explicit-setup-test-pass-cli");
    await page.getByLabel("Proton Pass · Share ID", { exact: true }).fill("setup-test-share");
    await page.getByLabel("Proton Pass · Item ID", { exact: true }).fill("setup-test-item");
    await page.getByRole("button", { name: "Modellzugang speichern", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(origin + "/api/v1/configuration")).json()).openrouter?.secretRef?.itemId,
      )
      .toBe("setup-test-item");
    await page.getByRole("button", { name: "Verbindung & Katalog prüfen", exact: true }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page.getByLabel("Modellzugang fortsetzen", { exact: true }).selectOption("later");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Gemeinsames Budget", exact: true })).toBeVisible();
    await page.getByLabel("Budgetlimit in USD", { exact: true }).fill("0");
    await page.getByLabel("Zeitraum von", { exact: true }).fill("2026-09-01");
    await page.getByLabel("Zeitraum bis", { exact: true }).fill("2026-10-01");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Ausführungsrechner", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ausführungsrechner", exact: true })).toBeVisible();
    await page.getByLabel("Ausführung fortsetzen", { exact: true }).selectOption("configured");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Kein Ausführungspfad");
    await page.getByLabel("Ausführung fortsetzen", { exact: true }).selectOption("later");
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    const areas = page.getByRole("region", { name: "Bereiche einrichten", exact: true });
    await areas.getByLabel("Neuer Bereich", { exact: true }).fill("Actually persisted business area");
    await areas.getByRole("button", { name: "Bereich anlegen", exact: true }).click();
    await expect(areas.getByText("Actually persisted business area", { exact: false })).toBeVisible();
    await page.reload();
    await expect(areas.getByText("Actually persisted business area", { exact: false })).toBeVisible();
    // Optional editors keep their own native validation, even after they have been touched.
    // Neither hidden required fields nor enabled draft channels may become navigation requirements.
    const connectionStep = page.getByRole("heading", { name: "Bereiche & Verbindungen", exact: true });
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(connectionStep).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Pflichtangaben und Bestätigungen");
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await areas.getByRole("button", { name: "Bereich anlegen", exact: true }).click();
    await expect(areas.getByLabel("Neuer Bereich", { exact: true })).toBeFocused();
    await page.getByText("Neue Verbindung einrichten", { exact: true }).click();
    await page.getByLabel("Dienstadresse (falls erforderlich)", { exact: true }).fill("not-a-url");
    const connectionForm = page.locator("form").filter({
      has: page.getByRole("button", { name: "Verbindung speichern", exact: true }),
    });
    for (const checkbox of await connectionForm.getByRole("checkbox").all()) await checkbox.check();
    await page.getByText("Kunden und Projekte einrichten (optional)", { exact: true }).click();
    const customerForm = page.getByRole("form", { name: "Kunde anlegen", exact: true });
    const projectForm = page.getByRole("form", { name: "Projekt anlegen", exact: true });
    await customerForm.getByLabel("Beschreibung", { exact: true }).fill("Unsaved customer draft");
    await projectForm.getByLabel("Beschreibung", { exact: true }).fill("Unsaved project draft");
    await customerForm.getByRole("button", { name: "Kunde anlegen", exact: true }).click();
    await expect(customerForm.getByLabel("Name", { exact: true })).toBeFocused();
    await page.getByText("Proton-Pass-Resolver für Eingänge", { exact: true }).click();
    await page.getByLabel("Eigenes Proton-Sitzungsverzeichnis (optional)", { exact: true }).fill("/draft/session");
    await page.getByLabel("Eingang ausdrücklich aktivieren", { exact: true }).check();
    await page.getByText("TLS-Postfach einrichten", { exact: true }).click();
    await page.getByLabel("Postfachadresse", { exact: true }).fill("not-an-email");
    expect(await page.locator("input:invalid,select:invalid,textarea:invalid").count()).toBeGreaterThan(1);
    await page.getByLabel(/Gespeicherte Bereiche und Verbindungen geprüft/).check();
    expect(await page.locator("#setup-navigation").evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(
      true,
    );
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Mandate & Routinen", exact: true })).toBeVisible();
    expect(mutations).toEqual(["PATCH /api/v1/setup"]);
    progress = await (await page.request.get(origin + "/api/v1/setup")).json();
    expect(progress.step).toBe(6);
    expect(JSON.stringify(progress.data)).not.toContain("Unsaved customer draft");
    expect(JSON.stringify(progress.data)).not.toContain("not-an-email");
    await page.getByLabel(/Konkrete Mandate und Routinen geprüft/).check();
    await page.getByRole("button", { name: "Speichern & weiter", exact: true }).click();
    const summary = page.getByRole("region", { name: "Tatsächlicher Einrichtungsstand", exact: true });
    await expect(summary.getByText("Live-Ausführung gesperrt", { exact: true })).toBeVisible();
    await expect(summary.getByText(/0 Worker mit bestätigtem Kontakt/)).toBeVisible();
    await page.screenshot({ path: "docs/test-evidence/setup-fresh-summary-local.png", fullPage: true });
    await page.getByLabel(/Den tatsächlichen Stand und die offenen Einrichtungspunkte geprüft/).check();
    await page.getByRole("button", { name: "Hauptquartier öffnen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
    progress = await (await page.request.get(origin + "/api/v1/setup")).json();
    expect(progress.step).toBe(8);
    expect(progress.data).not.toHaveProperty("password");
    expect(JSON.stringify(progress)).not.toContain(token);
    expect((await (await page.request.get(origin + "/api/v1/orders")).json()).items).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
