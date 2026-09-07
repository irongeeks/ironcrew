import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { WorkerClient } from "../../apps/worker/client.ts";
async function login(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
}
async function createOrder(page: Page, kind: string, goal: string) {
  const session = await (await page.request.get("/api/v1/session")).json(),
    company = await (await page.request.get("/api/v1/company")).json(),
    areas = await (await page.request.get("/api/v1/areas")).json();
  const response = await page.request.post("/api/v1/orders", {
    headers: { "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() },
    data: {
      scope: { companyId: company.id, areaId: areas.items[0].id },
      kind,
      goal,
      budgetLimitUsdMicros: "0",
      acceptanceCriteria: ["Lokaler Browsernachweis"],
    },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
function pdfFixture() {
  const stream = "BT /F1 18 Tf 40 740 Td (Lokaler Browserbeleg) Tj ET",
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test.describe("Real local administration (HTTP, SQLite, TLS worker; no mocked API)", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10000 });
  test("worker enrollment downloads one-time configuration, connects over verified TLS, rotates and revokes", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings/workers");
    const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-browser-worker-"));
    let client: WorkerClient | undefined;
    try {
      await page.getByLabel("Workername", { exact: true }).fill("Echter TLS Browserworker");
      await page.getByLabel("Basis-Datenverzeichnis auf dem Worker", { exact: true }).fill(directory);
      await page.getByLabel("workspace.read", { exact: true }).check();
      await page.getByRole("button", { name: "Anmelden und Zugang erzeugen", exact: true }).click();
      const panel = page.getByRole("region", { name: "Einmalige Worker-Zugangsdaten" });
      await expect(panel).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Worker-Konfiguration einmalig herunterladen", exact: true }).click();
      const downloaded = await downloadPromise,
        enrollment = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
      expect(enrollment.url).toMatch(/^wss:\/\/127\.0\.0\.1:/);
      expect(enrollment.generation).toBe(1);
      expect(enrollment.capabilities).toEqual(["workspace.read"]);
      expect(path.normalize(enrollment.directory)).toBe(path.join(directory, "generation-1"));
      expect((await page.locator("body").innerText()).includes(enrollment.token)).toBe(false);
      await expect(panel).toHaveCount(0);
      client = new WorkerClient({
        ...enrollment,
        ca: await readFile(new URL("../integration/worker-fixtures/cert.pem", import.meta.url)),
        execute: async () => {
          throw new Error("This UI fixture never executes a tool");
        },
      });
      await client.start();
      await expect
        .poll(
          async () =>
            (await (await page.request.get("/api/v1/workers")).json()).items.find(
              (worker: { id: string }) => worker.id === enrollment.workerId,
            )?.lastSeenAt,
        )
        .toBeTruthy();
      await client.stop();
      client = undefined;
      const row = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Echter TLS Browserworker", exact: true }) });
      await row.getByRole("button", { name: "Zugang rotieren", exact: true }).click();
      const rotatedDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Worker-Konfiguration einmalig herunterladen", exact: true }).click();
      const rotated = JSON.parse(await readFile((await (await rotatedDownload).path())!, "utf8"));
      expect(rotated.generation).toBe(2);
      expect(rotated.token === enrollment.token).toBe(false);
      await row.getByText("Workerzugang widerrufen", { exact: true }).click();
      await row.getByRole("button", { name: "Zugang jetzt widerrufen", exact: true }).click();
      await expect(row.getByText("Zugang widerrufen", { exact: false }).first()).toBeVisible();
      await expect
        .poll(
          async () =>
            (await (await page.request.get("/api/v1/workers")).json()).items.find(
              (worker: { id: string }) => worker.id === enrollment.workerId,
            )?.revoked,
        )
        .toBe(true);
    } finally {
      await client?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("channel administration persists scope and public key without a secret or implicit activation", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings/channels");
    await page.getByLabel("Eingangsprovider", { exact: true }).selectOption("discord");
    await page.getByLabel("Feste Provider-Account-ID", { exact: true }).fill("local-browser-discord-account");
    await page.getByLabel("Erlaubte Chat-/Kanal-IDs (eine je Zeile)", { exact: true }).fill("123456789");
    await page.getByLabel("Öffentlicher Discord-Schlüssel (64 Hexzeichen)", { exact: true }).fill("a".repeat(64));
    await expect(page.getByLabel("Eingang ausdrücklich aktivieren", { exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "Eingang speichern", exact: true }).click();
    await expect(page.getByText("Kanalkonfiguration gespeichert.", { exact: true })).toBeVisible();
    await page.reload();
    const row = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "discord · local-browser-discord-account", exact: true }) });
    await expect(row).toContainText("Eingang deaktiviert");
    await row.getByRole("button", { name: "Kanal bearbeiten", exact: true }).click();
    await page.getByLabel("Eingang ausdrücklich aktivieren", { exact: true }).check();
    await page.getByRole("button", { name: "Eingang speichern", exact: true }).click();
    await expect(row).toContainText("Eingang aktiviert");
    await row.getByRole("button", { name: "CEO-Verknüpfung beginnen", exact: true }).click();
    await expect(page.getByText("Verknüpfung im erlaubten Kanal abschließen", { exact: true })).toBeVisible();
    const config = (await (await page.request.get("/api/v1/channels/config")).json()).config;
    const channel = config.channels.find(
      (item: { accountId: string }) => item.accountId === "local-browser-discord-account",
    );
    expect(channel.enabled).toBe(true);
    expect(channel.conversationIds).toEqual(["123456789"]);
    expect(channel.secretRef).toBeUndefined();
    await page.getByRole("button", { name: "Verknüpfungsstand neu laden", exact: true }).click();
    await expect(row).toContainText("Noch keine verifizierte CEO-Verknüpfung.");
  });
  test("recorded local research change can be reviewed by the CEO and a new watch can be created and paused", async ({
    page,
  }) => {
    await login(page);
    const orders = (await (await page.request.get("/api/v1/orders")).json()).items;
    const order = orders.find((item: { goal: string }) => item.goal === "Lokale Quellenbeobachtung E2E");
    expect(order).toBeTruthy();
    await page.goto(`/orders/${order.id}`);
    const watch = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Bereits geprüfte lokale Änderung", exact: true }) });
    await watch.locator("summary").filter({ hasText: "Änderung zu beurteilen" }).click();
    await expect(watch.getByText("drei", { exact: true })).toBeVisible();
    await expect(watch.getByText("sechs", { exact: true })).toBeVisible();
    await watch.getByLabel("Folge für die Empfehlung", { exact: true }).selectOption("revise");
    await watch
      .getByLabel("Begründung der Änderungsbewertung", { exact: true })
      .fill("Ich habe die expliziten lokalen Quellenauszüge verglichen.");
    await watch
      .getByLabel("Überarbeitete Empfehlung", { exact: true })
      .fill("Sechs Tage als neue Planungsannahme verwenden.");
    await watch.getByRole("button", { name: "Persönliche Änderungsbewertung speichern", exact: true }).click();
    await expect(watch).toContainText("Bewertet: revise");
    await page.getByText("Neue Quellenbeobachtung", { exact: true }).click();
    const baselineId = await page
      .getByLabel("Ausgangsbericht", { exact: true })
      .locator("option")
      .filter({ hasText: "Lokaler E2E-Ausgangsbericht" })
      .getAttribute("value");
    await page.getByLabel("Ausgangsbericht", { exact: true }).selectOption(baselineId!);
    await page.getByLabel("Bezeichnung der Beobachtung", { exact: true }).fill("Im Browser konfigurierte Beobachtung");
    await page.getByLabel("Welche Änderungen sind relevant?", { exact: true }).fill("Neue bestätigte Lieferfristen.");
    await page
      .getByRole("group", { name: "Belegte Ausgangsquellen", exact: true })
      .getByLabel("Explizite lokale E2E-Quelle", { exact: true })
      .check();
    await page.getByRole("button", { name: "Beobachtung speichern", exact: true }).click();
    await expect(page.getByText("Quellenbeobachtung gespeichert.", { exact: true })).toBeVisible();
    const added = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Im Browser konfigurierte Beobachtung", exact: true }) });
    await expect(added).toContainText("Pausiert");
    await added.getByRole("button", { name: "Beobachtung aktivieren", exact: true }).click();
    await expect(added).toContainText("Aktiv");
    await added.getByRole("button", { name: "Beobachtung pausieren", exact: true }).click();
    await expect(added).toContainText("Pausiert");
    const current = (await (await page.request.get(`/api/v1/orders/${order.id}/research/watches`)).json()).items;
    const changed = current.find((item: { title: string }) => item.title === "Bereits geprüfte lokale Änderung");
    const checks = await (
      await page.request.get(`/api/v1/orders/${order.id}/research/watches/${changed.id}/checks`)
    ).json();
    expect(checks.reviews[0].reviewerKind).toBe("ceo");
  });
  test("PDF original is rendered on canvas beside classification, stored and checksum-verified after reload", async ({
    page,
  }) => {
    await login(page);
    const order = await createOrder(page, "finance", "PDF Originalvorschau im Browser");
    await page.goto(`/orders/${order.id}`);
    await page
      .getByLabel("Originalbeleg (PDF, PNG, JPEG; höchstens 700 KB)", { exact: true })
      .setInputFiles({ name: "local-browser-invoice.pdf", mimeType: "application/pdf", buffer: pdfFixture() });
    const preview = page.getByRole("complementary", { name: "Sichere Originalbelegvorschau", exact: true });
    await preview.getByText("Erkannter Seitentext", { exact: true }).click();
    await expect(preview.getByText("Lokaler Browserbeleg", { exact: true })).toBeVisible();
    expect(
      await preview.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.height > 0),
    ).toBe(true);
    for (const [label, value] of [
      ["Rechnungs-ID", "browser-pdf-invoice"],
      ["Lieferanten-ID", "browser-fixture-supplier"],
      ["Rechnungsnummer", "BROWSER-PDF-1"],
      ["Datenquelle / Belegreferenz", "local-browser-fixture:pdf"],
      ["Rechnungsbetrag", "100"],
      ["Belegt bezahlt", "20"],
      ["Fällig am", "2026-09-01"],
      ["Geprüfter Datenstand", "2026-09-07T09:00"],
    ])
      await page.getByLabel(label!, { exact: true }).fill(value!);
    await page.getByLabel("Forderung oder Verbindlichkeit", { exact: true }).selectOption("payable");
    await page.getByRole("button", { name: "Beleg erfassen", exact: true }).click();
    await expect(preview.getByText("Originalbytes anhand SHA-256 geprüft.", { exact: true })).toBeVisible();
    await page.reload();
    const option = page.getByLabel("Gespeicherten Beleg auswählen", { exact: true });
    await option.selectOption({ label: "BROWSER-PDF-1" });
    await expect(preview.getByText("Originalbytes anhand SHA-256 geprüft.", { exact: true })).toBeVisible();
    await preview.getByText("Erkannter Seitentext", { exact: true }).click();
    await expect(preview.getByText("Lokaler Browserbeleg", { exact: true })).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "apps/web/evidence/pdf-classification-local.png", fullPage: true });
  });
  test("backup policy requires an actual encrypted archive and restore probe before activation", async ({ page }) => {
    const age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age",
      keygen = process.env.IRONCREW_TEST_AGE_KEYGEN ?? path.join(path.dirname(age), "age-keygen");
    test.skip(!existsSync(age) || !existsSync(keygen), "Real age and age-keygen executables are required");
    const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-browser-backup-")),
      identity = path.join(directory, "identity.txt");
    try {
      await promisify(execFile)(keygen, ["--output", identity]);
      const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1]!;
      await login(page);
      await page.goto("/settings/backups");
      await page.getByText("Neuen Sicherungsplan vorbereiten", { exact: true }).click();
      for (const [label, value] of [
        ["Name des Sicherungsplans", "Echte lokale Sicherungsprobe"],
        ["Öffentlicher age-Schlüssel des Sicherungsplans", recipient],
        ["age-Programm des Sicherungsplans", age],
        ["Sicherungsverzeichnis außerhalb der Firmendaten", path.join(directory, "archives")],
      ])
        await page.getByLabel(label!, { exact: true }).fill(value!);
      await page.getByRole("button", { name: "Sicherungsplan als Entwurf speichern", exact: true }).click();
      const row = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Echte lokale Sicherungsprobe", exact: true }) });
      await expect(
        row.getByRole("button", { name: "Geprüften Sicherungsplan aktivieren", exact: true }),
      ).toBeDisabled();
      await row
        .getByLabel("age-Schlüsseldatei für Probe · Echte lokale Sicherungsprobe", { exact: true })
        .fill(identity);
      await row.getByRole("button", { name: "Sicherung und Wiederherstellungsprobe ausführen", exact: true }).click();
      await expect(row.getByText("Wiederherstellungsprobe liegt vor.", { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await row.getByRole("button", { name: "Geprüften Sicherungsplan aktivieren", exact: true }).click();
      await expect(row.getByText("Sicherungsplan aktiv", { exact: false })).toBeVisible();
      const state = await (await page.request.get("/api/v1/maintenance")).json();
      expect(
        state.backupPolicies.find((policy: { name: string }) => policy.name === "Echte lokale Sicherungsprobe").enabled,
      ).toBe(true);
      expect(state.probes.some((probe: { state: string }) => probe.state === "passed")).toBe(true);
      expect((await readFile(state.backups[0].archivePath)).toString().startsWith("age-encryption.org/v1\n")).toBe(
        true,
      );
      await row.getByRole("button", { name: "Sicherungsplan pausieren", exact: true }).click();
      await expect(row.getByText("Sicherungsplan nicht aktiv", { exact: false })).toBeVisible();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("hosting profile and bounded mandate produce a persisted approval that survives reload and can be denied without publication", async ({
    page,
  }) => {
    await login(page);
    const order = await createOrder(page, "website", "Lokaler Hostingfreigabe-Browsernachweis");
    await page.goto(`/orders/${order.id}`);
    await page.getByText("Hosting und Veröffentlichung", { exact: true }).click();
    await page.getByText("Neues Hostingprofil anlegen", { exact: true }).click();
    for (const [label, value] of [
      ["Name des Hostingprofils", "Lokales ungeprüftes Hostingziel"],
      ["HTTPS-Broker-Endpunkt", "https://broker.fixture.invalid"],
      ["Öffentliche HTTPS-Adresse (Rootpfad)", "https://site.fixture.invalid"],
      ["Tarifkennung des Brokers", "local-test"],
      ["Erlaubte DNS-IP-Adressen (eine je Zeile)", "127.0.0.1"],
      ["Erwartete Texte für Gesundheitsprüfung (einer je Zeile)", "Lokaler Test"],
    ])
      await page.getByLabel(label!, { exact: true }).fill(value!);
    await page
      .getByLabel("Broker ausdrücklich ohne Authorization-Header nutzen (separater Netzschutz erforderlich)", {
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Hostingprofil speichern", exact: true }).click();
    await page.getByText("Mandat für dieses Hostingziel erstellen", { exact: true }).click();
    await page.getByLabel("hosting.provision", { exact: true }).check();
    await page.getByLabel("Hostingmandat gültig bis", { exact: true }).fill("2099-01-01T00:00");
    await page.getByRole("button", { name: "Hostingmandat erteilen", exact: true }).click();
    const mandate = page.getByLabel("Gültiges Hostingmandat", { exact: true });
    await expect(mandate.locator("option")).toHaveCount(2);
    await mandate.selectOption({ index: 1 });
    await page
      .getByLabel("Ziel, Kosten und konkrete Version geprüft; separate Freigabe anfordern.", { exact: true })
      .check();
    await page.getByRole("button", { name: "Konkrete Hostingfreigabe anfordern", exact: true }).click();
    await expect(page.getByText(/Gespeicherte Hostingaktion: provision/)).toBeVisible();
    const before = await (await page.request.get(`/api/v1/orders/${order.id}/hosting`)).json();
    expect(before.resources).toHaveLength(0);
    expect(before.pendingActions).toHaveLength(1);
    const actionId = before.pendingActions[0].id;
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByText("Hosting und Veröffentlichung", { exact: true }).click();
    await expect(page.getByText(actionId, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Gebundene Freigabe in Entscheidungen prüfen", exact: true }).click();
    const approval = page.getByRole("article").filter({ has: page.getByText(actionId, { exact: true }) });
    await approval.getByRole("button", { name: "Ablehnen", exact: true }).click();
    await page.goto(`/orders/${order.id}`);
    await page.getByText("Hosting und Veröffentlichung", { exact: true }).click();
    const after = await (await page.request.get(`/api/v1/orders/${order.id}/hosting`)).json();
    expect(after.resources).toHaveLength(0);
    expect(after.deployments).toHaveLength(0);
    expect(after.pendingActions[0].status).toBe("denied");
  });
  test("notification center lists actual order events and read marking leaves approvals unchanged", async ({
    page,
  }) => {
    await login(page);
    const order = await createOrder(page, "research", "Echte Benachrichtigung im Browser");
    await page.getByRole("button", { name: /Benachrichtigungen öffnen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Benachrichtigungszentrum", exact: true });
    await expect(dialog.getByRole("button", { name: "Auftrag öffnen", exact: true }).first()).toBeVisible();
    const history = (await (await page.request.get("/api/v1/notifications?after=0&limit=200")).json()).items;
    expect(history.some((event: { orderId?: string }) => event.orderId === order.id)).toBe(true);
    const before = await (await page.request.get("/api/v1/approvals")).json();
    await dialog.getByRole("button", { name: "Angezeigte Ereignisse als gelesen markieren", exact: true }).click();
    const after = await (await page.request.get("/api/v1/approvals")).json();
    expect(after).toEqual(before);
    await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
    await expect(page.getByRole("button", { name: /Benachrichtigungen öffnen/ })).toBeFocused();
  });
});
