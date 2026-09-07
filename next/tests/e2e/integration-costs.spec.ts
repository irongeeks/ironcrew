import { test, expect, type Page } from "@playwright/test";
const target = "55555555-5555-4555-8555-555555555555";
async function fixture(page: Page) {
  const writes: { path: string; body: Record<string, unknown>; revision: string | undefined }[] = [];
  const config = {
    version: 1,
    connections: [
      {
        id: target,
        provider: "brave",
        schemaTag: "Explicit cost UI fixture",
        enabledTools: ["research.search"],
        pricing: { id: "66666666-6666-4666-8666-666666666666", version: 2 },
      },
    ],
    liveExecutionEnabled: false,
  };
  await page.route("**/api/v1/**", (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace("/api/v1", "");
    if (["POST", "PUT"].includes(req.method())) {
      const body = req.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body, revision: req.headers()["if-match"] });
      if (path === "/configuration") Object.assign(config, body);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "fixture", setupRequired: false },
      "/setup": { step: 8, data: {} },
      "/company": { id: target, name: "Cost UI fixture", timezone: "Europe/Berlin", revision: 1 },
      "/employees": { items: [] },
      "/areas": { items: [] },
      "/configuration": config,
      "/integration-costs": {
        charges: [
          {
            actionId: "charge-fixture",
            orderId: target,
            revision: 7,
            status: "unreconciled",
            price: { requestUsdMicros: "1200" },
          },
        ],
      },
    };
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data[path] ?? { items: [] }) });
  });
  return writes;
}
test("explicit UI fixture: saves precise price version and attributed evidence without floating-point loss", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto("/settings/budget");
  await page.getByText("Preis für Suchverbindung festlegen", { exact: true }).click();
  await page.getByLabel("Bestätigter Preis je Anfrage in USD").fill("0,001234");
  await page.getByLabel("Preisnachweis (HTTPS-Link)", { exact: true }).fill("https://example.invalid/price-evidence");
  await page.getByLabel("Gültig bis", { exact: true }).fill("2099-01-01T12:00");
  await page.getByRole("button", { name: "Neue Preisversion speichern" }).click();
  await expect(page.getByText("Neue Preisversion gespeichert.", { exact: true })).toBeVisible();
  expect(writes[0]?.body).toMatchObject({
    connections: [
      { pricing: { version: 3, requestUsdMicros: "1234", sourceUrl: "https://example.invalid/price-evidence" } },
    ],
  });
  await page.getByText("Mit Anbieterbeleg abgleichen", { exact: true }).click();
  await page.getByLabel("Tatsächliche Kosten in USD").fill("0.000001");
  await page.getByLabel("Belegformat", { exact: true }).selectOption("text/plain");
  await page.getByLabel("Anbieterbeleg", { exact: true }).setInputFiles({
    name: "charge.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("explicit fixture charge 0.000001 USD"),
  });
  await page
    .getByLabel("Zuordnung der Abrechnung", { exact: true })
    .fill("Attribution to this explicit local UI fixture action");
  await page.getByRole("button", { name: "Kosten mit Beleg bestätigen" }).click();
  await expect(page.getByText("Abrechnung mit Beleg gespeichert.", { exact: true })).toBeVisible();
  expect(writes[1]).toMatchObject({
    path: "/integration-costs/charge-fixture/reconcile",
    revision: "7",
    body: {
      actualUsdMicros: "1",
      evidence: {
        mediaType: "text/plain",
        contentBase64: Buffer.from("explicit fixture charge 0.000001 USD").toString("base64"),
      },
    },
  });
});
test("explicit UI fixture: English mobile controls reject unsupported decimal precision without a write", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/budget");
  await page.getByLabel("Sprache").selectOption("en");
  await page.getByText("Set search connection price", { exact: true }).click();
  await page.getByLabel("Confirmed price per request in USD").fill("0.0000001");
  await page.getByLabel("Price evidence (HTTPS link)", { exact: true }).fill("https://example.invalid/evidence");
  await page.getByLabel("Valid until", { exact: true }).fill("2099-01-01T12:00");
  await page.getByRole("button", { name: "Save new price version" }).click();
  await expect(page.getByRole("alert")).toContainText("6");
  expect(writes).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
