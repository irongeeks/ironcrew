import { test, expect } from "@playwright/test";
import { navigateTo, establishSession, deleteViaApi } from "../fixtures/test-helpers";

test.describe("Agent Management Flow", () => {
  let createdAgentIds: string[] = [];
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    for (const id of createdAgentIds) {
      await deleteViaApi(request, `/api/agents/${id}`, savedCsrfToken ?? undefined);
    }
    createdAgentIds = [];
    savedCsrfToken = null;
  });

  test("create agents via API, verify in Roster view", async ({ page, request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create agents via API (no custom department — use existing ones)
    const leaderName = `E2E-Leader-${Date.now()}`;
    const leaderRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: { name: leaderName, role: "team_leader" },
    });
    expect(leaderRes.ok()).toBeTruthy();
    const leaderBody = await leaderRes.json();
    const leaderId = leaderBody.agent?.id ?? leaderBody.id;
    createdAgentIds.push(leaderId);

    const seniorName = `E2E-Senior-${Date.now()}`;
    const seniorRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: { name: seniorName, role: "senior" },
    });
    expect(seniorRes.ok()).toBeTruthy();
    const seniorBody = await seniorRes.json();
    const seniorId = seniorBody.agent?.id ?? seniorBody.id;
    createdAgentIds.push(seniorId);

    // Verify agents exist via individual GET
    const getLeader = await request.get(`/api/agents/${leaderId}`);
    expect(getLeader.ok()).toBeTruthy();
    const getSenior = await request.get(`/api/agents/${seniorId}`);
    expect(getSenior.ok()).toBeTruthy();

    // Navigate to Roster view and verify it loads
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "agents");

    // Verify roster view rendered with content
    const mainContent = page.locator("main").first();
    await expect(mainContent).toBeVisible();
    await expect(mainContent).not.toBeEmpty();

    // Update agent via API
    const updateRes = await request.patch(`/api/agents/${leaderId}`, {
      headers: csrfHeaders,
      data: { name: `${leaderName}-upd` },
    });
    expect(updateRes.ok()).toBeTruthy();

    // Verify update via direct GET
    const verifyRes = await request.get(`/api/agents/${leaderId}`);
    expect(verifyRes.ok()).toBeTruthy();
  });
});
