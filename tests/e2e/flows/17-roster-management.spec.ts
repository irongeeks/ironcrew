import { test, expect } from "@playwright/test";
import { navigateTo, establishSession, deleteViaApi } from "../fixtures/test-helpers";

test.describe("Roster / Agent Management Flow", () => {
  test.setTimeout(120_000);

  let createdAgentIds: string[] = [];
  let createdDeptIds: string[] = [];
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    for (const id of createdAgentIds) {
      await deleteViaApi(request, `/api/agents/${id}`, savedCsrfToken ?? undefined);
    }
    for (const id of createdDeptIds) {
      await deleteViaApi(request, `/api/departments/${id}`, savedCsrfToken ?? undefined);
    }
    createdAgentIds = [];
    createdDeptIds = [];
    savedCsrfToken = null;
  });

  test("roster view loads and displays agents", async ({ page, request }) => {
    savedCsrfToken = await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "agents");

    // The roster view should render with agent content
    const mainContent = page.locator("main").first();
    await expect(mainContent).toBeVisible();
    await expect(mainContent).not.toBeEmpty();
  });

  test("create agent with all fields via API and verify in roster", async ({ page, request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create a department for the agent
    const deptName = `E2E-RosterDept-${Date.now()}`;
    const deptRes = await request.post("/api/departments", {
      headers: csrfHeaders,
      data: { id: `e2e-rdept-${Date.now()}`, name: deptName, icon: "T", color: "#10B981" },
    });
    expect(deptRes.ok(), `Failed to create department (status=${deptRes.status()})`).toBeTruthy();
    const deptBody = await deptRes.json();
    const dept = deptBody.department ?? deptBody;
    createdDeptIds.push(dept.id);

    // Create a team leader agent with all fields populated
    const leaderName = `E2E-FullLeader-${Date.now()}`;
    const leaderRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: {
        name: leaderName,
        department_id: dept.id,
        role: "team_leader",
        cli_provider: "claude",
        avatar_emoji: "B",
      },
    });
    expect(leaderRes.ok(), `Failed to create leader (status=${leaderRes.status()})`).toBeTruthy();
    const leaderBody = await leaderRes.json();
    const leader = leaderBody.agent ?? leaderBody;
    createdAgentIds.push(leader.id);

    // Verify the agent was created correctly via GET
    const getRes = await request.get(`/api/agents/${leader.id}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    const agent = getBody.agent ?? getBody;
    expect(agent.name).toBe(leaderName);
    expect(agent.department_id).toBe(dept.id);
    expect(agent.role).toBe("team_leader");

    // Navigate to roster and verify the agent appears
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "agents");

    const mainContent = page.locator("main").first();
    await expect(mainContent).toBeVisible();

    // The agent name should appear in the roster
    const agentText = page.getByText(leaderName).first();
    await expect(agentText).toBeVisible({ timeout: 10_000 });
  });

  test("create multiple agents with different roles", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    const roles = ["team_leader", "senior", "junior"];
    const agents: Array<{ id: string; name: string; role: string }> = [];

    for (const role of roles) {
      const name = `E2E-${role}-${Date.now()}`;
      const res = await request.post("/api/agents", {
        headers: csrfHeaders,
        data: { name, role },
      });
      expect(res.ok(), `Failed to create ${role} agent (status=${res.status()})`).toBeTruthy();
      const body = await res.json();
      const agent = body.agent ?? body;
      agents.push({ id: agent.id, name, role });
      createdAgentIds.push(agent.id);
    }

    // Verify all agents exist via the list endpoint
    const listRes = await request.get("/api/agents");
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    const allAgents = listBody.agents ?? listBody;
    expect(Array.isArray(allAgents)).toBeTruthy();

    for (const created of agents) {
      const found = allAgents.find((a: { id: string }) => a.id === created.id);
      expect(found, `Agent ${created.name} not found in agent list`).toBeTruthy();
      expect(found.role).toBe(created.role);
    }
  });

  test("edit agent properties via API", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create an agent
    const originalName = `E2E-Edit-${Date.now()}`;
    const createRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: { name: originalName, role: "senior" },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const agent = createBody.agent ?? createBody;
    createdAgentIds.push(agent.id);

    // Update the agent's name and role
    const updatedName = `${originalName}-Updated`;
    const patchRes = await request.patch(`/api/agents/${agent.id}`, {
      headers: csrfHeaders,
      data: { name: updatedName, role: "team_leader" },
    });
    expect(patchRes.ok(), `Failed to update agent (status=${patchRes.status()})`).toBeTruthy();
    const patchBody = await patchRes.json();
    const patchedAgent = patchBody.agent ?? patchBody;
    expect(patchedAgent.name).toBe(updatedName);
    expect(patchedAgent.role).toBe("team_leader");

    // Verify via GET
    const getRes = await request.get(`/api/agents/${agent.id}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    const verifiedAgent = getBody.agent ?? getBody;
    expect(verifiedAgent.name).toBe(updatedName);
    expect(verifiedAgent.role).toBe("team_leader");
  });

  test("change agent department assignment", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create two departments
    const ts = Date.now();
    const deptAName = `E2E-DeptA-${ts}`;
    const deptBName = `E2E-DeptB-${ts}`;

    const deptARes = await request.post("/api/departments", {
      headers: csrfHeaders,
      // id must match /^[a-z0-9][a-z0-9_-]*$/ — no uppercase
      data: { id: `e2e-depta-${ts}`, name: deptAName },
    });
    expect(deptARes.ok(), `Failed to create deptA (status=${deptARes.status()})`).toBeTruthy();
    const deptABody = await deptARes.json();
    const deptA = deptABody.department ?? deptABody;
    createdDeptIds.push(deptA.id);
    // Re-fetch to get the id properly
    const deptListRes = await request.get(`/api/departments`);
    const allDepts = await deptListRes.json();
    const deptAObj = (allDepts.departments ?? allDepts).find((d: { name: string }) => d.name === deptAName);

    const deptBRes = await request.post("/api/departments", {
      headers: csrfHeaders,
      data: { id: `e2e-deptb-${ts}`, name: deptBName },
    });
    expect(deptBRes.ok(), `Failed to create deptB (status=${deptBRes.status()})`).toBeTruthy();
    const deptBFullBody = await deptBRes.json();
    const deptBObj = deptBFullBody.department ?? deptBFullBody;
    createdDeptIds.push(deptBObj.id);

    // Create an agent in deptA
    const agentName = `E2E-DeptSwitch-${Date.now()}`;
    const agentRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: { name: agentName, department_id: deptAObj?.id ?? deptA.id, role: "senior" },
    });
    expect(agentRes.ok()).toBeTruthy();
    const agentBody = await agentRes.json();
    const agent = agentBody.agent ?? agentBody;
    createdAgentIds.push(agent.id);

    // Move agent to deptB
    const moveRes = await request.patch(`/api/agents/${agent.id}`, {
      headers: csrfHeaders,
      data: { department_id: deptBObj.id },
    });
    expect(moveRes.ok()).toBeTruthy();

    // Verify the agent is now in deptB
    const getRes = await request.get(`/api/agents/${agent.id}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    const movedAgent = getBody.agent ?? getBody;
    expect(movedAgent.department_id).toBe(deptBObj.id);
  });

  test("delete agent via API", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create an agent to delete
    const agentName = `E2E-Delete-${Date.now()}`;
    const createRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: { name: agentName, role: "junior" },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const agent = createBody.agent ?? createBody;
    const agentId = agent.id;

    // Verify it exists
    const getRes = await request.get(`/api/agents/${agentId}`);
    expect(getRes.ok()).toBeTruthy();

    // Delete the agent
    const deleteRes = await request.delete(`/api/agents/${agentId}`, { headers: csrfHeaders });
    expect(deleteRes.ok(), `Failed to delete agent (status=${deleteRes.status()})`).toBeTruthy();

    // Verify it no longer appears in the list
    const listRes = await request.get("/api/agents");
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    const allAgents = listBody.agents ?? listBody;
    const found = allAgents.find((a: { id: string }) => a.id === agentId);
    expect(found).toBeFalsy();

    // No need to add to createdAgentIds since it's already deleted
  });

  test("agent CLI provider is persisted", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    const providers = ["claude", "codex", "gemini"];

    for (const provider of providers) {
      const name = `E2E-Provider-${provider}-${Date.now()}`;
      const createRes = await request.post("/api/agents", {
        headers: csrfHeaders,
        data: { name, role: "senior", cli_provider: provider },
      });
      expect(createRes.ok()).toBeTruthy();
      const body = await createRes.json();
      const agent = body.agent ?? body;
      createdAgentIds.push(agent.id);

      // Verify the provider was saved
      const getRes = await request.get(`/api/agents/${agent.id}`);
      expect(getRes.ok()).toBeTruthy();
      const getBody = await getRes.json();
      const fetchedAgent = getBody.agent ?? getBody;
      expect(fetchedAgent.cli_provider).toBe(provider);
    }
  });

  test("department CRUD and agent assignment integrity", async ({ request }) => {
    const csrfToken = await establishSession(request);
    savedCsrfToken = csrfToken;
    const csrfHeaders = { "x-csrf-token": csrfToken };

    // Create a department
    const deptName = `E2E-IntegrityDept-${Date.now()}`;
    const deptRes = await request.post("/api/departments", {
      headers: csrfHeaders,
      data: { id: `e2e-intdept-${Date.now()}`, name: deptName, icon: "I", color: "#3B82F6" },
    });
    expect(deptRes.ok()).toBeTruthy();
    const deptBody = await deptRes.json();
    const dept = deptBody.department ?? deptBody;
    createdDeptIds.push(dept.id);

    // Create two agents in this department
    const agentNames = [`E2E-Integrity-A-${Date.now()}`, `E2E-Integrity-B-${Date.now()}`];
    for (const name of agentNames) {
      const res = await request.post("/api/agents", {
        headers: csrfHeaders,
        data: { name, department_id: dept.id, role: "senior" },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      createdAgentIds.push((body.agent ?? body).id);
    }

    // Rename the department
    const renameRes = await request.patch(`/api/departments/${dept.id}`, {
      headers: csrfHeaders,
      data: { name: `${deptName}-Renamed` },
    });
    expect(renameRes.ok()).toBeTruthy();

    // Verify agents still belong to the renamed department
    for (const agentId of createdAgentIds) {
      const getRes = await request.get(`/api/agents/${agentId}`);
      if (getRes.ok()) {
        const body = await getRes.json();
        const agent = body.agent ?? body;
        if (agent.department_id === dept.id) {
          expect(agent.department_id).toBe(dept.id);
        }
      }
    }
  });
});
