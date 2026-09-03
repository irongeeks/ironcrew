import { test, expect } from "../fixtures/company-setup";
import { deleteViaApi } from "../fixtures/test-helpers";

// TODO: Add UI interactions — currently API-only integration tests
test.describe("Task Lifecycle Flow", () => {
  let taskId: string | null = null;
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    if (taskId) await deleteViaApi(request, `/api/tasks/${taskId}`, savedCsrfToken ?? undefined);
  });

  test("create task, assign, verify status transitions via API", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;
    // Create task with agent pre-assigned — response: { id, task }
    const taskRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Test Task",
        description: "Automated E2E test task",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "planned",
      },
    });
    expect(taskRes.ok()).toBeTruthy();
    const taskBody = await taskRes.json();
    taskId = taskBody.id;
    expect(taskId).toBeTruthy();

    // Update status to in_progress
    const progressRes = await request.patch(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "in_progress" },
    });
    expect(progressRes.ok()).toBeTruthy();

    // Update status to done
    const doneRes = await request.patch(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "done" },
    });
    expect(doneRes.ok()).toBeTruthy();

    // Check terminal endpoint
    const terminalRes = await request.get(`/api/tasks/${taskId}/terminal?lines=10`);
    expect(terminalRes.ok()).toBeTruthy();
  });
});
