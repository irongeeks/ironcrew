import { test, expect } from "@playwright/test";
test("real authenticated API persists a scoped order and chat across browser reload", async ({ page }) => {
  // Persistence is the subject here; HQ animation performance has its own dedicated tests.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: /Anmelden|Sign in/i }).click();
  await expect(page.getByRole("heading", { name: /Hauptquartier|Alles im Blick/i, level: 1 })).toBeVisible();
  const session = await page.request.get("/api/v1/session");
  const csrf = (await session.json()).csrfToken;
  const areas = (await (await page.request.get("/api/v1/areas")).json()).items;
  const created = await page.request.post("/api/v1/orders", {
    headers: { "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() },
    data: {
      scope: { companyId: areas[0].companyId, areaId: areas[0].id },
      kind: "research",
      goal: "Echter persistierter Browserauftrag",
      budgetLimitUsdMicros: "0",
      acceptanceCriteria: ["Gespräch nach Reload erhalten"],
    },
  });
  expect(created.ok()).toBe(true);
  const order = await created.json();
  await page.goto("/orders/" + order.id);
  await expect(page.getByText("Echter persistierter Browserauftrag").first()).toBeVisible();
  const posted = await page.request.post(`/api/v1/orders/${order.id}/messages`, {
    headers: { "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() },
    data: { content: "Diese Nachricht bleibt in SQLite erhalten." },
  });
  expect(posted.ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("Diese Nachricht bleibt in SQLite erhalten.")).toBeVisible();
  await page.screenshot({ path: "docs/test-evidence/real-order-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: "docs/test-evidence/real-order-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
