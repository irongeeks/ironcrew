import { test, expect } from "@playwright/test";
import { establishSession, navigateTo } from "../fixtures/test-helpers";

test.describe("Reports Flow", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("task reports API returns data", async ({ request }) => {
    const res = await request.get("/api/task-reports");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.reports).toBeTruthy();
    expect(Array.isArray(body.reports)).toBeTruthy();
  });

  test("report history overlay opens", async ({ page }) => {
    // Legacy reports remain available in the explicitly labelled legacy tools.
    await navigateTo(page, "projects");
    await page.getByRole("button", { name: "More actions", exact: true }).filter({ visible: true }).click();
    const reportBtn = page.getByRole("button", { name: /Report History/ });
    await expect(reportBtn).toBeVisible();
    await reportBtn.click();

    await expect(
      page.getByRole("heading", { name: /Report History|Berichtsverlauf|작업 보고서 이력|レポート履歴/ }),
    ).toBeVisible();
  });

  test("individual task report shows content", async ({ page, request }) => {
    const reportsRes = await request.get("/api/task-reports");
    const body = await reportsRes.json();
    test.skip(!body.reports || body.reports.length === 0, "No task reports available to test");

    const taskId = body.reports[0].id;
    const reportRes = await request.get(`/api/task-reports/${taskId}`);
    expect(reportRes.ok()).toBeTruthy();
    const report = await reportRes.json();
    expect(report).toBeTruthy();
  });
});
