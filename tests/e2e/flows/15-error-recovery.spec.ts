import { test, expect } from "../fixtures/company-setup";
import { deleteViaApi } from "../fixtures/test-helpers";

test.describe("Error Recovery Flow", () => {
  test.setTimeout(120_000);

  let taskId: string | null = null;
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    if (taskId) {
      await deleteViaApi(request, `/api/tasks/${taskId}`, savedCsrfToken ?? undefined);
      taskId = null;
    }
  });

  test("task stop and resume after simulated failure", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task in in_progress (simulates an agent running)
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Error Recovery Task",
        description: "Test error recovery after agent failure",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "in_progress",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;

    // Stop the task (simulates agent failure/crash recovery)
    const stopRes = await request.post(`/api/tasks/${taskId}/stop`, {
      headers: { "x-csrf-token": csrfToken },
      data: { mode: "cancel" },
    });
    expect(stopRes.ok(), `Stop failed (status=${stopRes.status()})`).toBeTruthy();
    const stopBody = await stopRes.json();
    expect(stopBody.ok).toBe(true);
    expect(stopBody.status).toBe("cancelled");

    // Verify the task is cancelled
    const getRes = await request.get(`/api/tasks/${taskId}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    const task = getBody.task ?? getBody;
    expect(task.status).toBe("cancelled");

    // Resume the task
    const resumeRes = await request.post(`/api/tasks/${taskId}/resume`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resumeRes.ok(), `Resume failed (status=${resumeRes.status()})`).toBeTruthy();
    const resumeBody = await resumeRes.json();
    expect(resumeBody.ok).toBe(true);
    expect(resumeBody.status).toBe("planned");

    // Verify the task is back in planned state
    const verifyRes = await request.get(`/api/tasks/${taskId}`);
    expect(verifyRes.ok()).toBeTruthy();
    const verifyBody = await verifyRes.json();
    const verifiedTask = verifyBody.task ?? verifyBody;
    expect(verifiedTask.status).toBe("planned");
  });

  test("single phase reset returns phase to pending", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task with a workflow pack
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Single Phase Reset",
        description: "Test single phase reset",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "in_progress",
        workflow_pack: "development",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;

    // Seed a pipeline subtask and mark it done
    const phaseId = "e2e_single_reset";
    const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
      headers: { "x-csrf-token": csrfToken },
      data: { title: `[pipeline:${phaseId}]`, description: "Phase to reset" },
    });
    expect(subtaskRes.ok()).toBeTruthy();
    const subtaskBody = await subtaskRes.json();
    const subtaskId = subtaskBody.id ?? subtaskBody.entity?.id;

    // Mark subtask as done
    const doneRes = await request.patch(`/api/subtasks/${subtaskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "done" },
    });
    expect(doneRes.ok()).toBeTruthy();

    // Verify it is done
    const beforeRes = await request.get(`/api/tasks/${taskId}`);
    const beforeBody = await beforeRes.json();
    const beforeSubs = beforeBody.subtasks ?? [];
    const doneSub = beforeSubs.find((s: { title: string }) => s.title === `[pipeline:${phaseId}]`);
    expect(doneSub.status).toBe("done");
    expect(doneSub.completed_at).toBeTruthy();

    // Reset the single phase
    const resetRes = await request.post(`/api/core/tasks/${taskId}/phases/${phaseId}/reset`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetRes.ok(), `Phase reset failed (status=${resetRes.status()})`).toBeTruthy();
    const resetBody = await resetRes.json();
    expect(resetBody.reset).toBe(true);
    expect(resetBody.phaseId).toBe(phaseId);

    // Verify the subtask is now pending
    const afterRes = await request.get(`/api/tasks/${taskId}`);
    expect(afterRes.ok()).toBeTruthy();
    const afterBody = await afterRes.json();
    const afterSubs = afterBody.subtasks ?? [];
    const resetSub = afterSubs.find((s: { title: string }) => s.title === `[pipeline:${phaseId}]`);
    expect(resetSub.status).toBe("pending");
    expect(resetSub.completed_at).toBeFalsy();
  });

  test("reset-from resets target phase and all downstream phases", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task WITHOUT a workflow pack so the fallback creation-order reset runs.
    // If a pack key is present, the graph-based reset only resets phases known to the
    // pack DAG — ad-hoc phase IDs like phase_a/b/c would not appear in the adjacency
    // map, so downstream phases would not be reset.
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Reset-From Phases",
        description: "Test reset-from cascading reset",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "review",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;

    // Seed three pipeline subtasks: phase_a, phase_b, phase_c
    // Simulate a linear sequence where resetting phase_a should also reset phase_b and phase_c
    const phaseIds = ["phase_a", "phase_b", "phase_c"];
    const subtaskIds: string[] = [];

    for (const phaseId of phaseIds) {
      const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
        headers: { "x-csrf-token": csrfToken },
        data: { title: `[pipeline:${phaseId}]`, description: `Phase: ${phaseId}` },
      });
      expect(subtaskRes.ok()).toBeTruthy();
      const body = await subtaskRes.json();
      subtaskIds.push(body.id ?? body.entity?.id);
    }

    // Mark all subtasks as done
    for (const sid of subtaskIds) {
      const patchRes = await request.patch(`/api/subtasks/${sid}`, {
        headers: { "x-csrf-token": csrfToken },
        data: { status: "done" },
      });
      expect(patchRes.ok()).toBeTruthy();
    }

    // Verify all are done
    const beforeRes = await request.get(`/api/tasks/${taskId}`);
    const beforeBody = await beforeRes.json();
    const beforeSubs = (beforeBody.subtasks ?? []).filter((s: { title: string }) =>
      s.title.startsWith("[pipeline:phase_"),
    );
    expect(beforeSubs.every((s: { status: string }) => s.status === "done")).toBeTruthy();

    // Reset from phase_a — should reset phase_a + downstream (phase_b, phase_c)
    const resetFromRes = await request.post(`/api/core/tasks/${taskId}/phases/reset-from/phase_a`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetFromRes.ok(), `Reset-from failed (status=${resetFromRes.status()})`).toBeTruthy();
    const resetFromBody = await resetFromRes.json();
    expect(resetFromBody.reset).toBe(true);
    expect(resetFromBody.resetPhases.length).toBeGreaterThanOrEqual(1);
    // The target phase (phase_a) must be in the reset list
    expect(resetFromBody.resetPhases).toContain("phase_a");

    // Verify all phases were reset
    const afterRes = await request.get(`/api/tasks/${taskId}`);
    expect(afterRes.ok()).toBeTruthy();
    const afterBody = await afterRes.json();
    const afterSubs = (afterBody.subtasks ?? []).filter((s: { title: string }) =>
      s.title.startsWith("[pipeline:phase_"),
    );
    // None should be "done" after a reset-from the first phase
    const stillDone = afterSubs.filter((s: { status: string }) => s.status === "done");
    expect(stillDone.length).toBe(0);

    // The target phase should be "pending", downstream should be "pending" or "blocked"
    const targetSub = afterSubs.find((s: { title: string }) => s.title === "[pipeline:phase_a]");
    expect(targetSub.status).toBe("pending");

    // Task status should be moved back to planned (since it was in "review")
    const taskStatus = (afterBody.task ?? afterBody).status;
    expect(taskStatus).toBe("planned");
  });

  test("phase reset on non-existent phase returns 404", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Missing Phase Reset",
        description: "Test 404 on non-existent phase",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "planned",
        workflow_pack: "development",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;

    // Try to reset a phase that does not exist
    const resetRes = await request.post(`/api/core/tasks/${taskId}/phases/nonexistent_phase_xyz/reset`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetRes.status()).toBe(404);
    const resetBody = await resetRes.json();
    expect(resetBody.error).toBe("phase_not_found");
  });

  test("phase reset on non-existent task returns 404", async ({ request, csrfToken }) => {
    savedCsrfToken = csrfToken;

    const resetRes = await request.post("/api/core/tasks/nonexistent-task-id/phases/some_phase/reset", {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetRes.status()).toBe(404);
    const resetBody = await resetRes.json();
    expect(resetBody.error).toBe("task_not_found");
  });

  test("task done status reverts to planned after phase reset", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task marked as done
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Done-to-Planned Reset",
        description: "Verify task status reverts from done to planned on phase reset",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "done",
        workflow_pack: "development",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;

    // Seed a done pipeline subtask
    const phaseId = "final_phase";
    const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
      headers: { "x-csrf-token": csrfToken },
      data: { title: `[pipeline:${phaseId}]`, description: "Final phase" },
    });
    expect(subtaskRes.ok()).toBeTruthy();
    const subtaskBody = await subtaskRes.json();
    const subtaskId = subtaskBody.id ?? subtaskBody.entity?.id;

    await request.patch(`/api/subtasks/${subtaskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "done" },
    });

    // Reset the phase
    const resetRes = await request.post(`/api/core/tasks/${taskId}/phases/${phaseId}/reset`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(resetRes.ok()).toBeTruthy();

    // Verify the task status was reverted to planned
    const getRes = await request.get(`/api/tasks/${taskId}`);
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    const task = getBody.task ?? getBody;
    expect(task.status).toBe("planned");
  });
});
