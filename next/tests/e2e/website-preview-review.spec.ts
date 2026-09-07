import { test, expect } from "@playwright/test";
test("real local concept sandbox blocks navigation and old previews cannot approve the current version", async ({
  page,
}) => {
  // This test covers sandbox and version binding; animated HQ performance is tested separately.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/v1/session")).json(),
    areas = await (await page.request.get("/api/v1/areas")).json();
  const headers = () => ({ "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() });
  async function post(url: string, data: unknown) {
    const res = await page.request.post(`/api/v1${url}`, { headers: headers(), data });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }
  const order = await post("/orders", {
      scope: { companyId: areas.items[0].companyId, areaId: areas.items[0].id },
      kind: "website",
      goal: "Preview security and version binding",
      budgetLimitUsdMicros: "0",
    }),
    base = `/orders/${order.id}`;
  await post(`${base}/website`, { briefing: "Explicit local safety/version fixture", stack: "static" });
  const concepts = await post(`${base}/website/concepts`, {
    concepts: [
      {
        name: "Inert navigation probe",
        rationale: "Actual sandbox navigation evidence",
        html: '<!doctype html><meta http-equiv="refresh" content="0; url=https://example.invalid/blocked-probe"><a style="display:block;padding:20px" href="https://example.invalid/blocked-probe">Blocked external link</a><img src="https://example.invalid/blocked-probe">',
      },
      { name: "Local page", rationale: "Plain local build", html: "<!doctype html><h1>First local version</h1>" },
    ],
  });
  const outbound: string[] = [];
  await page.route("https://example.invalid/**", (route) => {
    outbound.push(route.request().url());
    return route.abort();
  });
  await page.goto(base);
  await page.getByText(/Konzepte vergleichen/).click();
  const probe = page.locator('iframe[title="Konzeptvorschau: Inert navigation probe"]');
  await expect(probe).toHaveAttribute("sandbox", "");
  await expect(probe).toHaveAttribute("inert", "");
  const link = probe.contentFrame().getByText("Blocked external link", { exact: true });
  await expect(link).toBeVisible();
  const bounds = await link.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.click(bounds!.x + 10, bounds!.y + 10);
  await page.waitForTimeout(150);
  expect(outbound).toHaveLength(0);
  await expect(link).toBeVisible();
  await post(`${base}/website/select`, { conceptId: concepts.data.concepts[1].id });
  const first = await post(`${base}/website/build`, {});
  await post(`${base}/website/revision`, {
    expectedArtifactVersionId: first.id,
    html: "<!doctype html><h1>Second local version</h1>",
    changeDescription: "Explicit second artifact",
  });
  const second = await post(`${base}/website/build`, {});
  await post(`${base}/website/review`, {
    artifactVersionId: second.id,
    checks: ["mobile", "functional", "quality"].map((name) => ({
      name,
      passed: true,
      evidence: "Explicit local human review fixture",
    })),
  });
  await page.reload();
  await page.getByLabel("Vorschauversion vergleichen", { exact: true }).selectOption(first.id);
  await expect(page.getByRole("button", { name: "Diese Version abnehmen", exact: true })).toHaveCount(0);
  await expect(page.getByText("Manuelle Prüfung protokollieren", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Mobil", exact: true }).click();
  await page.getByRole("button", { name: "Stelle in Vorschau markieren", exact: true }).click();
  const marker = page.getByRole("button", { name: "Markierung in der Vorschau", exact: true });
  await marker.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Elementanker (z. B. #hero)", { exact: true })).toHaveValue("viewport-point:30,30");
  await page.getByLabel("Kommentar", { exact: true }).fill("Point on earlier mobile version");
  await page.getByRole("button", { name: "Feedback speichern", exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1${base}/website/pins`)).json()).items.length)
    .toBe(1);
  const pins = (await (await page.request.get(`/api/v1${base}/website/pins`)).json()).items;
  expect(pins[0]).toMatchObject({
    artifactVersionId: first.id,
    viewport: { width: 390, height: 650 },
    anchor: "viewport-point:30,30",
    state: "draft",
  });
  await page.getByLabel("Vorschauversion vergleichen", { exact: true }).selectOption(second.id);
  await expect(page.getByText("Manuelle Prüfung protokollieren", { exact: true })).toBeVisible();
});
