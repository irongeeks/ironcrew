import { test, expect } from "@playwright/test";
import { establishSession, deleteViaApi } from "../fixtures/test-helpers";

// TODO: Add UI interactions — currently API-only integration tests
test.describe("Project Setup Flow", () => {
  let csrfToken: string;
  let deptId: string | null = null;
  let agentId: string | null = null;
  let projectId: string | null = null;

  test.beforeEach(async ({ request }) => {
    csrfToken = await establishSession(request);
    const csrfHeaders = { "x-csrf-token": csrfToken };
    const dept = await (
      await request.post("/api/departments", {
        headers: csrfHeaders,
        data: { name: `E2E-ProjDept-${Date.now()}` },
      })
    ).json();
    deptId = dept.id;
    const agent = await (
      await request.post("/api/agents", {
        headers: csrfHeaders,
        data: { name: `E2E-ProjAgent-${Date.now()}`, department_id: dept.id, role: "team_leader" },
      })
    ).json();
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (projectId) await deleteViaApi(request, `/api/projects/${projectId}`, csrfToken);
    if (agentId) await deleteViaApi(request, `/api/agents/${agentId}`, csrfToken);
    if (deptId) await deleteViaApi(request, `/api/departments/${deptId}`, csrfToken);
  });

  test("create project, update, verify via API", async ({ request }) => {
    const projectName = `E2E-Project-${Date.now()}`;

    // Create — response: { ok, project }
    const createRes = await request.post("/api/projects", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        name: projectName,
        project_path: "/tmp/e2e-test-project",
        core_goal: "E2E test",
        assignment_mode: "auto",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    projectId = createBody.project.id;
    expect(createBody.project.name).toBe(projectName);

    // Update
    const updateRes = await request.patch(`/api/projects/${projectId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { name: `${projectName}-updated` },
    });
    expect(updateRes.ok()).toBeTruthy();

    // Verify via GET — response: { project }
    const getRes = await request.get(`/api/projects/${projectId}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.project.name).toBe(`${projectName}-updated`);

    // Verify in list — response may be array or { projects: [...] }
    const listRes = await request.get("/api/projects");
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    const projects = Array.isArray(listBody) ? listBody : (listBody.projects ?? []);
    const found = projects.find((p: { id: string }) => p.id === projectId);
    expect(found).toBeTruthy();
  });
});
