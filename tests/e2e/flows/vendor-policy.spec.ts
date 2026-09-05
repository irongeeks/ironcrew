import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { CompanyPolicySnapshot } from "../../../src/shared/company-policy";

const endpoint = "/api/crew/policies/vendor";
const cleanups = new Map<string, (request: APIRequestContext) => Promise<void>>();
const snapshot = async (request: APIRequestContext) =>
  expectOkJson<CompanyPolicySnapshot>(await request.get(endpoint), "Read company policy");

test.afterEach(async ({ request }, testInfo) => {
  const cleanup = cleanups.get(testInfo.testId);
  cleanups.delete(testInfo.testId);
  await cleanup?.(request);
});

test("owner restrictions persist, block provider checks, and reject stale revisions", async ({
  page,
  request,
}, testInfo) => {
  const headers = { "x-csrf-token": await establishSession(request) };
  const before = await snapshot(request);
  cleanups.set(testInfo.testId, async (request) => {
    const current = await snapshot(request);
    await expectOkJson(
      await request.put(endpoint, {
        headers,
        data: {
          baseRevision: current.revision,
          baselineFingerprint: current.baselineFingerprint,
          reason: "Restore original company policy after browser test",
          restrictions: before.restrictions,
        },
      }),
      "Restore policy",
    );
  });
  expect(before.restrictions.allowedProviders).toContain("DeepInfra");
  expect(before.restrictions.allowedFamilies).toContain("mistralai/*");
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("open-vendor-policy").click();
  const panel = page.getByRole("region", { name: "Vendor- und Provider-Freigaben", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("checkbox", { name: "DeepInfra", exact: true }).uncheck();
  await panel.getByRole("checkbox", { name: "mistralai/*", exact: true }).uncheck();
  const reason = "Provider und Modellfamilie für dokumentierten Browsertest einschränken";
  await panel.getByRole("textbox", { name: "Begründung der Änderung", exact: true }).fill(reason);
  const saveResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === endpoint && response.request().method() === "PUT",
  );
  await panel.getByRole("button", { name: "Freigaben speichern", exact: true }).click();
  expect((await saveResponse).ok()).toBe(true);
  await expect(panel.getByRole("status").filter({ hasText: "Freigaben gespeichert" })).toBeVisible();
  const saved = await snapshot(request);
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.effectivePolicy.openrouter.allowed_providers).not.toContain("DeepInfra");
  expect(saved.effectivePolicy.allowed_families).not.toContain("mistralai/*");
  expect(saved.history[0].reason).toBe(reason);
  expect(saved.history[0].auditEventId).toBeTruthy();
  const stale = await request.put(endpoint, {
    headers,
    data: {
      baseRevision: before.revision,
      baselineFingerprint: before.baselineFingerprint,
      reason: "Stale browser test must not overwrite owner choices",
      restrictions: before.restrictions,
    },
  });
  expect(stale.status()).toBe(409);
  expect((await snapshot(request)).revision).toBe(saved.revision);
  await page.reload();
  await page.getByTestId("open-vendor-policy").click();
  await expect(panel.getByRole("checkbox", { name: "DeepInfra", exact: true })).not.toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "mistralai/*", exact: true })).not.toBeChecked();
  await panel.getByRole("textbox", { name: "Modell-ID", exact: true }).fill("openai/browser-policy-example");
  await panel.getByRole("textbox", { name: "Provider (optional)", exact: true }).fill("DeepInfra");
  await panel.getByRole("button", { name: "Gespeicherte Policy prüfen", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Blockiert: openai/browser-policy-example" })).toBeVisible();
  await panel.getByText(/^Änderungsverlauf \(/).click();
  await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath("vendor-policy-persisted.png") });
});
