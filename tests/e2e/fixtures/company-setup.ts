import { test as base, expect } from "@playwright/test";
import { establishSession } from "./test-helpers";

export type CompanyFixture = {
  csrfToken: string;
  department: { id: string; name: string };
  teamLeader: { id: string; name: string };
  seniorAgent: { id: string; name: string };
  project: { id: string; name: string };
};

export const test = base.extend<CompanyFixture>({
  csrfToken: async ({ request }, use) => {
    const token = await establishSession(request);
    await use(token);
  },

  // Depend on csrfToken to ensure session is established before API calls
  department: async ({ request, csrfToken }, use) => {
    const csrfHeaders = { "x-csrf-token": csrfToken };
    const suffix = Date.now();
    const deptId = `e2e-dept-${suffix}`;
    const deptName = `E2E-Dept-${suffix}`;
    const createRes = await request.post("/api/departments", {
      headers: csrfHeaders,
      data: { id: deptId, name: deptName },
    });
    expect(createRes.ok(), `Failed to create department (status=${createRes.status()})`).toBeTruthy();
    const body = await createRes.json();
    const dept = body.department ?? body;
    expect(dept.id).toBeTruthy();

    await use({ id: dept.id, name: deptName });

    await request.delete(`/api/departments/${dept.id}`, { headers: csrfHeaders });
  },

  teamLeader: async ({ request, csrfToken, department }, use) => {
    const csrfHeaders = { "x-csrf-token": csrfToken };
    const agentName = `E2E-Leader-${Date.now()}`;
    const createRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: {
        name: agentName,
        department_id: department.id,
        role: "team_leader",
      },
    });
    const createBodyText = await createRes.text();
    expect(
      createRes.ok(),
      `Failed to create team leader (status=${createRes.status()}, body=${createBodyText})`,
    ).toBeTruthy();
    const body = JSON.parse(createBodyText) as Record<string, unknown>;
    const agent = (body.agent ?? body) as { id: string };
    expect(agent.id).toBeTruthy();

    await use({ id: agent.id, name: agentName });

    await request.delete(`/api/agents/${agent.id}`, { headers: csrfHeaders });
  },

  seniorAgent: async ({ request, csrfToken, department }, use) => {
    const csrfHeaders = { "x-csrf-token": csrfToken };
    const agentName = `E2E-Senior-${Date.now()}`;
    const createRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: {
        name: agentName,
        department_id: department.id,
        role: "senior",
      },
    });
    const createBodyText = await createRes.text();
    expect(
      createRes.ok(),
      `Failed to create senior agent (status=${createRes.status()}, body=${createBodyText})`,
    ).toBeTruthy();
    const body = JSON.parse(createBodyText) as Record<string, unknown>;
    const agent = (body.agent ?? body) as { id: string };
    expect(agent.id).toBeTruthy();

    await use({ id: agent.id, name: agentName });

    await request.delete(`/api/agents/${agent.id}`, { headers: csrfHeaders });
  },

  project: async ({ request, csrfToken }, use) => {
    const projectName = `E2E-Project-${Date.now()}`;
    const createRes = await request.post("/api/projects", {
      headers: { "x-csrf-token": csrfToken },
      data: { name: projectName, core_goal: "E2E test project", project_path: `/tmp/e2e-project-${Date.now()}` },
    });
    expect(createRes.ok(), `Failed to create project (status=${createRes.status()})`).toBeTruthy();
    const body = await createRes.json();
    const project = body.project ?? body;
    expect(project.id).toBeTruthy();

    await use({ id: project.id, name: projectName });

    await request.delete(`/api/projects/${project.id}`, {
      headers: { "x-csrf-token": csrfToken },
    });
  },
});

export { expect };
