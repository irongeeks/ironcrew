import { test, expect, type Page } from "@playwright/test";
const id = "55555555-5555-4555-8555-555555555555";
async function fixture(page: Page, step = 8) {
  let ready = false;
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", "");
    if (req.method() === "POST") {
      writes.push(path);
      if (path.endsWith("/plan")) ready = true;
      return route.fulfill({ json: {} });
    }
    const order = {
      id,
      kind: "research",
      goal: "UI readiness fixture",
      status: ready ? "ready" : "planning",
      revision: ready ? 2 : 1,
      scope: { companyId: id, areaId: id },
      acceptanceCriteria: [],
    };
    const models = Array.from({ length: 580 }, (_, i) => ({
      id: i === 578 ? "openrouter/free" : `fixture/model-${i}`,
      name: `Catalog fixture ${i}`,
      available: i !== 579,
    }));
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "fixture", setupRequired: false },
      "/setup": { step, data: {} },
      "/company": { id, name: "Setup controls fixture", revision: 1 },
      "/areas": { items: [{ id, name: "Fixture area" }] },
      "/employees": { items: [] },
      "/configuration": { liveExecutionEnabled: true, connections: [] },
      "/models": {
        items: models.slice(offset, offset + 100),
        nextCursor: offset + 100 < models.length ? String(offset + 100) : null,
      },
      "/mandates": { items: [{ id, title: "Fixture mandate" }] },
      "/orders": { items: [order] },
      [`/orders/${id}`]: order,
      [`/orders/${id}/workflow`]: { state: "not_started" },
    };
    if (path === "/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ json: data[path] ?? { items: [] } });
  });
  return writes;
}
test("setup summary counts the complete paginated catalog", async ({ page }) => {
  await fixture(page, 7);
  await page.goto("/setup");
  await expect(page.getByRole("region", { name: "Tatsächlicher Einrichtungsstand" })).toContainText(
    "579 Katalogeinträge",
  );
});
test("run needs a prepared order and labels the free router recommendation", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/orders/${id}`);
  await page.getByText("Crew-Ausführung starten", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Innerhalb des Mandats ausführen" })).toBeDisabled();
  await expect(page.getByLabel("Modell", { exact: true }).locator("option").first()).toHaveAttribute(
    "value",
    "openrouter/free",
  );
  await expect(page.getByLabel("Modell", { exact: true }).locator("option").first()).toContainText(
    "Empfohlenes Free-Sammelmodell",
  );
  await page.getByText("Arbeitsplan festlegen", { exact: true }).click();
  await page.getByLabel("Arbeitsschritte (einer je Zeile)").fill("Quellen prüfen");
  await page.getByLabel("Abnahmekriterien", { exact: true }).fill("Quellen dokumentiert");
  await page.getByRole("button", { name: "Neue Planversion speichern" }).click();
  await expect(page.getByRole("button", { name: "Innerhalb des Mandats ausführen" })).toBeEnabled();
  expect(writes).toEqual([`/orders/${id}/plan`]);
});
test("invalid mandate target IDs are explained inline before a request", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/settings/mandates");
  await page.getByText("Konkretes Mandat erteilen", { exact: true }).click();
  const form = page.locator("form").filter({ has: page.locator('textarea[name="targetIds"]') });
  await form.locator('textarea[name="targetIds"]').fill("not-a-uuid");
  // Exercise submit validation independently of unrelated required mandate fields.
  await form.evaluate((element) => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(form.getByRole("alert")).toContainText("Erlaubte Ziel-IDs: Zeile 1 muss eine gültige UUID sein.");
  await expect(form.locator('textarea[name="targetIds"]')).toHaveAttribute("aria-invalid", "true");
  expect(writes).toEqual([]);
});
