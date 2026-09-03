import { test, expect } from "../fixtures/company-setup";
import { deleteViaApi } from "../fixtures/test-helpers";

test.describe("Task Operations — Stop / Resume", () => {
  let taskId: string | null = null;
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    if (taskId) {
      await deleteViaApi(request, `/api/tasks/${taskId}`, savedCsrfToken ?? undefined);
      taskId = null;
    }
  });

  test("stop a task via API", async ({ request, csrfToken, teamLeader, project, department }) => {
    savedCsrfToken = csrfToken;

    // 1. Create a task with status "in_progress"
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Stop Test Task",
        description: "Task to test stop operation",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "in_progress",
      },
    });
    expect(createRes.ok(), `Failed to create task (status=${createRes.status()})`).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;
    expect(taskId).toBeTruthy();

    // 2. POST /api/tasks/:id/stop with { mode: "cancel" }
    const stopRes = await request.post(`/api/tasks/${taskId}/stop`, {
      headers: { "x-csrf-token": csrfToken },
      data: { mode: "cancel" },
    });
    expect(stopRes.ok(), `Stop request failed (status=${stopRes.status()})`).toBeTruthy();
    const stopBody = await stopRes.json();

    // 3. Verify response has ok: true
    expect(stopBody.ok).toBe(true);
    expect(stopBody.status).toBe("cancelled");
    expect(typeof stopBody.rolled_back).toBe("boolean");

    // 4. GET /api/tasks/:id and verify status changed
    const getRes = await request.get(`/api/tasks/${taskId}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.task.status).toBe("cancelled");
  });

  test("resume a stopped task via API", async ({ request, csrfToken, teamLeader, project, department }) => {
    savedCsrfToken = csrfToken;

    // 1. Create a task
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Resume Test Task",
        description: "Task to test resume operation",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "in_progress",
      },
    });
    expect(createRes.ok(), `Failed to create task (status=${createRes.status()})`).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;
    expect(taskId).toBeTruthy();

    // 2. Stop it
    const stopRes = await request.post(`/api/tasks/${taskId}/stop`, {
      headers: { "x-csrf-token": csrfToken },
      data: { mode: "cancel" },
    });
    expect(stopRes.ok(), `Stop request failed (status=${stopRes.status()})`).toBeTruthy();

    // 3. POST /api/tasks/:id/resume
    const resumeRes = await request.post(`/api/tasks/${taskId}/resume`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resumeRes.ok(), `Resume request failed (status=${resumeRes.status()})`).toBeTruthy();
    const resumeBody = await resumeRes.json();

    // 4. Verify response has ok: true
    expect(resumeBody.ok).toBe(true);
    expect(typeof resumeBody.auto_resumed).toBe("boolean");

    // 5. Verify status changed to resumable state
    // With an assigned agent, target status should be "planned"
    expect(resumeBody.status).toBe("planned");

    // Confirm via GET
    const getRes = await request.get(`/api/tasks/${taskId}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.task.status).toBe("planned");
  });

  test("bulk-hide tasks by status", async ({ request, csrfToken, teamLeader, project, department }) => {
    savedCsrfToken = csrfToken;
    const taskIds: string[] = [];

    // 1. Create 2 tasks with status "done"
    for (let i = 0; i < 2; i++) {
      const createRes = await request.post("/api/tasks", {
        headers: { "x-csrf-token": csrfToken },
        data: {
          title: `E2E Bulk-Hide Task ${i + 1}`,
          description: "Task to test bulk-hide",
          project_id: project.id,
          department_id: department.id,
          assigned_agent_id: teamLeader.id,
          status: "done",
        },
      });
      expect(createRes.ok(), `Failed to create task ${i + 1} (status=${createRes.status()})`).toBeTruthy();
      const body = await createRes.json();
      taskIds.push(body.id);
    }
    // Use the first task id for afterEach cleanup
    taskId = taskIds[0];

    // 2. POST /api/tasks/bulk-hide with { statuses: ["done"], hidden: 1 }
    const hideRes = await request.post("/api/tasks/bulk-hide", {
      headers: { "x-csrf-token": csrfToken },
      data: { statuses: ["done"], hidden: 1 },
    });
    expect(hideRes.ok(), `Bulk-hide request failed (status=${hideRes.status()})`).toBeTruthy();
    const hideBody = await hideRes.json();
    expect(hideBody.ok).toBe(true);
    expect(hideBody.affected).toBeGreaterThanOrEqual(2);

    // 3. Unhide: POST /api/tasks/bulk-hide with { statuses: ["done"], hidden: 0 }
    const unhideRes = await request.post("/api/tasks/bulk-hide", {
      headers: { "x-csrf-token": csrfToken },
      data: { statuses: ["done"], hidden: 0 },
    });
    expect(unhideRes.ok(), `Bulk-unhide request failed (status=${unhideRes.status()})`).toBeTruthy();
    const unhideBody = await unhideRes.json();
    expect(unhideBody.ok).toBe(true);
    expect(unhideBody.affected).toBeGreaterThanOrEqual(2);

    // Cleanup the second task (afterEach only cleans the first)
    await deleteViaApi(request, `/api/tasks/${taskIds[1]}`, csrfToken);
  });

  test("phase reset on a pipeline subtask", async ({ request, csrfToken, teamLeader, project, department }) => {
    savedCsrfToken = csrfToken;

    // 1. Create a task with workflow_pack: "development"
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Phase Reset Task",
        description: "Task to test phase reset",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "planned",
        workflow_pack: "development",
      },
    });
    expect(createRes.ok(), `Failed to create task (status=${createRes.status()})`).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;
    expect(taskId).toBeTruthy();

    // 2. Seed a pipeline subtask so the phase reset endpoint has something to reset
    const phaseId = "e2e_test_phase";
    const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
      headers: { "x-csrf-token": csrfToken },
      data: { title: `[pipeline:${phaseId}]`, description: "Seeded for phase reset test" },
    });
    expect(subtaskRes.ok(), `Failed to create pipeline subtask (status=${subtaskRes.status()})`).toBeTruthy();

    // 2b. Mark the subtask as "done" so the reset has observable effect
    const subtaskBody = await subtaskRes.json();
    const subtaskId = subtaskBody.id ?? subtaskBody.entity?.id;
    if (subtaskId) {
      await request.patch(`/api/subtasks/${subtaskId}`, {
        headers: { "x-csrf-token": csrfToken },
        data: { status: "done" },
      });
    }

    // 3. POST /api/core/tasks/:taskId/phases/:phaseId/reset
    const resetRes = await request.post(`/api/core/tasks/${taskId}/phases/${phaseId}/reset`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetRes.ok(), `Phase reset failed (status=${resetRes.status()})`).toBeTruthy();
    const resetBody = await resetRes.json();

    // 4. Verify response envelope
    expect(resetBody.reset).toBe(true);
    expect(resetBody.phaseId).toBe(phaseId);

    // 5. Verify the subtask was actually reset to pending in the database
    const taskRes = await request.get(`/api/tasks/${taskId}`);
    expect(taskRes.ok()).toBeTruthy();
    const taskBody = await taskRes.json();
    const subtasks = taskBody.subtasks ?? [];
    const resetSubtask = subtasks.find((s: { title: string }) => s.title === `[pipeline:${phaseId}]`);
    expect(resetSubtask).toBeTruthy();
    expect(resetSubtask.status).toBe("pending");
    expect(resetSubtask.completed_at).toBeFalsy();
  });
});
