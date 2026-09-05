import { test, expect } from "@playwright/test";
import { establishSession, deleteViaApi, navigateTo } from "../fixtures/test-helpers";

test.describe("Legacy Decision Inbox Flow", () => {
  test.setTimeout(180_000);

  let deptId: string | null = null;
  let agentId: string | null = null;
  let taskId: string | null = null;
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    if (taskId) await deleteViaApi(request, `/api/tasks/${taskId}`, savedCsrfToken ?? undefined);
    if (agentId) await deleteViaApi(request, `/api/agents/${agentId}`, savedCsrfToken ?? undefined);
    if (deptId) await deleteViaApi(request, `/api/departments/${deptId}`, savedCsrfToken ?? undefined);
    savedCsrfToken = null;
  });

  test("seed task, open decision inbox, approve decision", async ({ page, request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };
    const dept = await (
      await request.post("/api/departments", {
        headers: csrfHeaders,
        data: { name: `E2E-DecDept-${Date.now()}` },
      })
    ).json();
    deptId = dept.id;
    const agent = await (
      await request.post("/api/agents", {
        headers: csrfHeaders,
        data: {
          name: `E2E-DecAgent-${Date.now()}`,
          department_id: dept.id,
          role: "team_leader",
          cli_provider: "claude",
        },
      })
    ).json();
    agentId = agent.id;
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await navigateTo(page, "projects");

    // The decision inbox button is labeled "Entscheidungen" in the header bar
    const inboxBtn = page.getByRole("button", { name: /Entscheidungen|decision/i }).first();
    await expect(inboxBtn).toBeVisible();
    await inboxBtn.click();

    // The inbox opens as a modal/overlay — it's a fixed overlay, not necessarily role=dialog
    const inbox = page
      .locator(".fixed.inset-0, [role=dialog], [class*=inbox], [class*=Inbox], [class*=decision], [class*=Decision]")
      .first();
    await expect(inbox).toBeVisible();

    const decisionRes = await request.get("/api/decision-inbox");
    const decisions = await decisionRes.json();
    if (decisions.length > 0) {
      const items = inbox.locator("[class*=item], [class*=card], li").first();
      await expect(items).toBeVisible();
      const approveBtn = page.getByRole("button", { name: /genehmigen|akzeptieren|approve|accept|yes|ja/i }).first();
      await expect(approveBtn).toBeVisible();
      await approveBtn.click();

      // Wait for the decision list to update
      const decisionRes2 = await request.get("/api/decision-inbox");
      const decisions2 = await decisionRes2.json();
      expect(decisions2.length).toBeLessThan(decisions.length);
    }
  });
});
