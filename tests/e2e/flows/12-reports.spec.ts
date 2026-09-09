import { test, expect } from "@playwright/test";
import { establishSession, navigateTo, expectOkJson } from "../fixtures/test-helpers";

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

  test("individual task report shows content", async ({ request }) => {
    const csrf = await establishSession(request);
    const headers = { "x-csrf-token": csrf };
    const title = `E2E report fixture ${Date.now()}`;
    const { id } = await expectOkJson<{ id: string }>(
      await request.post("/api/tasks", {
        headers,
        data: { title, description: "Verified report fixture", status: "planned" },
      }),
      "Create report fixture",
    );
    try {
      await expectOkJson(
        await request.patch(`/api/tasks/${id}`, { headers, data: { status: "done" } }),
        "Complete fixture",
      );
      const { reports } = await expectOkJson<{ reports: Array<{ id: string }> }>(
        await request.get("/api/task-reports"),
        "List reports",
      );
      expect(reports.some((report) => report.id === id)).toBe(true);
      const report = await expectOkJson<{ task: { id: string; title: string; description: string } }>(
        await request.get(`/api/task-reports/${id}`),
        "Read report detail",
      );
      expect(report.task).toMatchObject({ id, title, description: "Verified report fixture" });
    } finally {
      await expectOkJson(await request.delete(`/api/tasks/${id}`, { headers }), "Delete report fixture");
    }
  });
});
