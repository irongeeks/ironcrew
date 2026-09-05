import { expect, test } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { BusinessDashboardSnapshot } from "../../../src/shared/business-dashboard";

test("business sources expose setup state without inventing metrics or starting external refresh", async ({
  page,
  request,
}, testInfo) => {
  await establishSession(request);
  const snapshot = await expectOkJson<BusinessDashboardSnapshot>(
    await request.get("/api/crew/business-dashboard"),
    "Read business sources",
  );
  expect(snapshot.sources).toHaveLength(6);
  // CI has no provider accounts. A missing source is a setup state, not a zero KPI.
  for (const source of snapshot.sources) {
    expect(["not_installed", "not_configured"]).toContain(source.state);
    expect(source.metrics).toEqual([]);
    expect(source.fetchedAt).toBeNull();
  }
  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/business-dashboard/") && request.method() === "POST") refreshes.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/");
  await page.getByTestId("open-business-dashboard").click();
  const panel = page.getByRole("region", { name: "Geschäftsdaten", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(6);
  for (const source of snapshot.sources)
    await expect(panel.getByRole("button", { name: `${source.label} aktualisieren`, exact: true })).toBeDisabled();
  expect(refreshes).toEqual([]);
  await panel.getByRole("heading", { name: "Geschäftsdaten", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("business-dashboard-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("heading", { name: "Geschäftsdaten", exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("heading", { name: "Geschäftsdaten", exact: true })).toBeInViewport();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("business-dashboard-mobile.png") });
});
