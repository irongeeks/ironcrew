import { test, expect } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { ObjectiveSnapshot, ObjectiveMeasurement } from "../../../src/shared/objective-evaluations";
test("creates an immutable rubric, measures a persisted mock run and reproduces its result", async ({
  page,
  request,
}, testInfo) => {
  const csrf = await establishSession(request);
  const headers = { "x-csrf-token": csrf };
  const endpoint = "/api/crew/evaluations";
  let snapshot = await expectOkJson<ObjectiveSnapshot>(await request.get(endpoint), "Read objective evaluations");
  if (!snapshot.runs.some((run) => run.runtimeType === "mock")) {
    await expectOkJson(
      await request.post("/api/crew/chat", {
        headers,
        data: { body: "Bitte dokumentiere das interne Backup-Verfahren als Testnachweis." },
      }),
      "Create mock evidence task",
    );
    await expectOkJson(await request.post("/api/crew/tasks/execute-next", { headers }), "Execute mock evidence task");
    snapshot = await expectOkJson<ObjectiveSnapshot>(await request.get(endpoint), "Read completed mock evidence");
  }
  const run = snapshot.runs.find((item) => item.runtimeType === "mock");
  expect(run, "The test requires actual persisted MockRuntime output").toBeDefined();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("open-evaluations").click();
  const panel = page.getByRole("region", { name: "Objektive Tests", exact: true });
  await expect(panel).toBeVisible();
  const key = `e2e-output-${Date.now()}`;
  await panel.getByLabel("Rubrikkennung", { exact: true }).fill(key);
  await panel.getByLabel("Titel", { exact: true }).fill("Testdaten: gespeicherte Abschlussnachricht");
  await panel.getByLabel("Änderungsgrund", { exact: true }).fill("Reproduzierbaren Prüflauf mit MockRuntime belegen.");
  await panel.getByLabel("Bezeichnung", { exact: true }).fill("Abschlussformulierung vorhanden");
  await panel.getByLabel("Vergleichstext", { exact: true }).fill("Aufgabe abgeschlossen");
  const savedResponse = page.waitForResponse(
    (response) => response.url().endsWith(`${endpoint}/rubrics`) && response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Rubrikversion speichern", exact: true }).click();
  const saved = await expectOkJson<{ rubric: { id: string; version: number } }>(
    await savedResponse,
    "Save objective rubric",
  );
  await expect(panel.getByRole("status")).toContainText("Rubrikversion gespeichert");
  const runSelect = panel.getByRole("combobox", { name: "Abgeschlossener Run", exact: true });
  await expect(runSelect.locator(`option[value="${run!.id}"]`)).toBeAttached();
  await runSelect.selectOption(run!.id);
  const measuredResponse = page.waitForResponse(
    (response) => response.url().endsWith(`${endpoint}/measure`) && response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Run auswerten", exact: true }).click();
  const { measurement } = await expectOkJson<{ measurement: ObjectiveMeasurement }>(
    await measuredResponse,
    "Persist objective measurement",
  );
  expect(measurement.run.id).toBe(run!.id);
  expect(measurement.rubricId).toBe(saved.rubric.id);
  expect(measurement.totalCases).toBe(1);
  // IDs are present in the backend response; select the visible evidence by its real run id.
  const evidence = panel
    .getByRole("region", { name: "Auswertungsverlauf" })
    .locator("details")
    .filter({ hasText: run!.id })
    .first();
  await expect(evidence).toBeAttached();
  await evidence.locator("summary").click();
  await expect(evidence).toContainText(`${measurement.passedCases}/1 erfüllt`);
  await evidence.getByRole("button", { name: "Nachweis reproduzieren", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("alle Einzelresultate stimmen überein");
  await evidence.locator("summary").scrollIntoViewIfNeeded();
  await expect(evidence.locator("summary")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("objective-evaluations-evidence.png") });
  const heading = panel.getByRole("heading", { name: "Objektive Tests", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("objective-evaluations-desktop.png") });
  const replay = await expectOkJson<{ checks: ObjectiveMeasurement["checks"] }>(
    await request.get(`${endpoint}/${measurement.id}/replay`),
    "Replay immutable evidence",
  );
  expect(replay.checks).toEqual(measurement.checks);
  const repeated = await expectOkJson<{ measurement: ObjectiveMeasurement }>(
    await request.post(`${endpoint}/measure`, { headers, data: { rubricId: saved.rubric.id, runId: run!.id } }),
    "Idempotent repeated measurement",
  );
  expect(repeated.measurement.id).toBe(measurement.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport();
  await expect(panel.getByRole("button", { name: "Aktualisieren", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("objective-evaluations-mobile.png") });
  await page.reload();
  await page.getByTestId("open-evaluations").click();
  await expect(panel.getByRole("region", { name: "Rubrikverlauf" })).toContainText(
    "Testdaten: gespeicherte Abschlussnachricht",
  );
});
