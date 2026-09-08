import { test, expect, type Page } from "@playwright/test";
const id = "55555555-5555-4555-8555-555555555555";
async function fixture(page: Page, missing = false) {
  const writes: { path: string; body: unknown; revision?: string }[] = [];
  let settled = false;
  await page.route("**/api/v1/**", (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace("/api/v1", "");
    if (req.method() === "POST") {
      writes.push({ path, body: req.postDataJSON(), revision: req.headers()["if-match"] });
      settled = true;
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "fixture", setupRequired: false },
      "/setup": { step: 8, data: {} },
      "/company": { id, name: "Explicit model cost UI fixture", timezone: "UTC", revision: 1 },
      "/employees": { items: [] },
      "/areas": { items: [] },
      "/configuration": { connections: [] },
      "/integration-costs": { charges: [] },
      "/model-costs": {
        turns: [
          {
            id,
            orderId: id,
            revision: settled ? 4 : 3,
            modelId: "fixture/model",
            ...(missing ? {} : { providerId: "gen-fixture" }),
            reservationState: settled ? "settled" : "unreconciled",
            reservedUsdMicros: "100",
            responseAvailable: !missing,
            ...(settled ? { actualUsdMicros: "1" } : {}),
          },
        ],
      },
    };
    if (path === "/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data[path] ?? { items: [] }) });
  });
  return writes;
}
test("explicit model cost UI fixture sends only the saved turn and its revision to provider reconciliation", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto("/settings/budget");
  await page.getByRole("button", { name: "Gespeicherte Generation beim Anbieter abgleichen" }).click();
  await expect(
    page.getByText("Modellkosten abgeglichen. Ein verlorenes Modellergebnis bleibt ungeklärt.", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([{ path: `/model-costs/${id}/provider`, body: {}, revision: "3" }]);
});
test("explicit mobile model cost UI fixture stores evidence and keeps missing response visibly unresolved", async ({
  page,
}) => {
  const writes = await fixture(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/budget");
  await expect(page.getByText("Modellantwort nicht gespeichert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gespeicherte Generation beim Anbieter abgleichen" })).toHaveCount(0);
  await page.getByText("Mit Anbieterbeleg manuell zuordnen", { exact: true }).click();
  await page.getByLabel("Tatsächlich abgerechnete USD", { exact: true }).fill("0,000001");
  await page.getByLabel("Belegformat", { exact: true }).selectOption("text/plain");
  await page.getByLabel("Originalbeleg", { exact: true }).setInputFiles({
    name: "provider.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Explicit local billing fixture"),
  });
  await page
    .getByLabel("Zuordnung zu diesem Modellaufruf", { exact: true })
    .fill("Explicit local interrupted model call");
  await page.getByRole("button", { name: "Belegte Kosten bestätigen" }).click();
  await expect(
    page.getByText("Modellkosten abgeglichen. Ein verlorenes Modellergebnis bleibt ungeklärt.", { exact: true }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    path: `/model-costs/${id}/manual`,
    revision: "3",
    body: {
      actualUsdMicros: "1",
      evidence: { contentBase64: Buffer.from("Explicit local billing fixture").toString("base64") },
    },
  });
  await expect(page.getByText("Modellantwort nicht gespeichert")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("missing response discard requires explicit acknowledgement and binds the saved run revision", async ({
  page,
}) => {
  const writes = await fixture(page, true);
  await page.route("**/api/v1/model-costs", (route) =>
    route.fulfill({
      json: {
        turns: [
          {
            id,
            orderId: id,
            modelId: "fixture/model",
            reservationState: "settled",
            responseAvailable: false,
            discardAvailable: true,
            runRevision: 8,
          },
        ],
      },
    }),
  );
  await page.goto("/settings/budget");
  const button = page.getByRole("button", { name: "Fehlende Modellantwort ausdrücklich verwerfen" });
  await button.click();
  expect(writes).toEqual([]);
  await page
    .getByLabel("Die fehlende Antwort verwerfen. Ein späterer Neustart kann erneut Modellkosten verursachen.")
    .check();
  await button.click();
  await expect(
    page.getByText(
      "Fehlende Antwort ausdrücklich verworfen. Den Auftrag bei Bedarf erneut starten; dabei können neue Modellkosten entstehen.",
    ),
  ).toBeVisible();
  expect(writes).toEqual([{ path: `/orders/${id}/model-response/discard`, body: { turnId: id }, revision: "8" }]);
});
