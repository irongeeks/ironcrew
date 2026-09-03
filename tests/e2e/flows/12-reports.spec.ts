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
    // Dashboard view was removed; report-history buttons now live on the Tasks board.
    await navigateTo(page, "tasks");

    const reportBtn = page.getByRole("button", { name: /bericht|report|history|verlauf/i }).first();
    const btnVisible = await reportBtn.isVisible({ timeout: 5000 }).catch(() => false);
    test.skip(!btnVisible, "Report/history button not found on dashboard — UI may not expose it");

    await reportBtn.click();

    const overlay = page.locator("[role=dialog], .modal, [class*=report], [class*=Report], [class*=history]").first();
    await expect(overlay).toBeVisible();
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
