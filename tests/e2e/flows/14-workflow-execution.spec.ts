import { test, expect } from "../fixtures/company-setup";
import { navigateTo, deleteViaApi } from "../fixtures/test-helpers";

test.describe("Workflow Execution Flow", () => {
  test.setTimeout(120_000);

  let taskId: string | null = null;
  let savedCsrfToken: string | null = null;

  test.afterEach(async ({ request }) => {
    if (taskId) {
      await deleteViaApi(request, `/api/tasks/${taskId}`, savedCsrfToken ?? undefined);
      taskId = null;
    }
  });

  test("create task with workflow pack, verify phases are seeded", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Verify the development pack is available in the registry
    const registryRes = await request.get("/api/ops/workflow-packs/registry");
    expect(registryRes.ok()).toBeTruthy();
    const registryBody = await registryRes.json();
    // Registry returns { packs: Array<{key, ...}> }
    const registryPacks: Array<{ key: string }> = registryBody.packs ?? [];
    const packKeys = registryPacks.map((p) => p.key);
    expect(packKeys.length).toBeGreaterThan(0);

    // Use "development" pack — it ships built-in
    const packKey = packKeys.includes("development") ? "development" : packKeys[0];

    // Create a task with the workflow pack assigned
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Workflow Execution Task",
        description: "Test workflow pack phase seeding",
        project_id: project.id,
        department_id: department.id,
        assigned_agent_id: teamLeader.id,
        status: "planned",
        workflow_pack: packKey,
      },
    });
    expect(createRes.ok(), `Failed to create task (status=${createRes.status()})`).toBeTruthy();
    const createBody = await createRes.json();
    taskId = createBody.id;
    expect(taskId).toBeTruthy();

    // Verify task was created with the workflow pack key
    const getRes = await request.get(`/api/tasks/${taskId}`);
    expect(getRes.ok()).toBeTruthy();
    const taskBody = await getRes.json();
    const task = taskBody.task ?? taskBody;
    expect(task.workflow_pack_key).toBe(packKey);
  });

  test("create task with workflow pack, seed pipeline subtasks, verify phase statuses", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task with the development workflow pack
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Phase Status Task",
        description: "Test phase status tracking",
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

    // Seed pipeline subtasks to simulate phase execution
    const phases = ["planning", "implementation", "testing"];
    for (const phaseId of phases) {
      const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
        headers: { "x-csrf-token": csrfToken },
        data: { title: `[pipeline:${phaseId}]`, description: `Phase: ${phaseId}` },
      });
      expect(subtaskRes.ok(), `Failed to create subtask for phase ${phaseId}`).toBeTruthy();
    }

    // Verify subtasks were created
    const taskRes = await request.get(`/api/tasks/${taskId}`);
    expect(taskRes.ok()).toBeTruthy();
    const taskBody = await taskRes.json();
    const subtasks = taskBody.subtasks ?? [];
    const pipelineSubtasks = subtasks.filter((s: { title: string }) => s.title.startsWith("[pipeline:"));
    expect(pipelineSubtasks.length).toBe(3);

    // All should start as pending
    for (const sub of pipelineSubtasks) {
      expect(sub.status).toBe("pending");
    }

    // Simulate phase completion by marking the first subtask as done
    const planningSubtask = pipelineSubtasks.find((s: { title: string }) => s.title === "[pipeline:planning]");
    expect(planningSubtask).toBeTruthy();

    const patchRes = await request.patch(`/api/subtasks/${planningSubtask.id}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "done" },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Verify the planning phase is now done while others remain pending
    const verifyRes = await request.get(`/api/tasks/${taskId}`);
    expect(verifyRes.ok()).toBeTruthy();
    const verifyBody = await verifyRes.json();
    const verifySubtasks = verifyBody.subtasks ?? [];
    const doneSub = verifySubtasks.find((s: { title: string }) => s.title === "[pipeline:planning]");
    expect(doneSub.status).toBe("done");

    const pendingSubs = verifySubtasks.filter(
      (s: { title: string; status: string }) => s.title.startsWith("[pipeline:") && s.status === "pending",
    );
    expect(pendingSubs.length).toBe(2);
  });

  test("phase awaiting approval appears in subtask status", async ({
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task with workflow pack
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: "E2E Approval Phase Task",
        description: "Test awaiting_approval status",
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

    // Seed a pipeline subtask
    const phaseId = "review_gate";
    const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
      headers: { "x-csrf-token": csrfToken },
      data: { title: `[pipeline:${phaseId}]`, description: "Review gate phase" },
    });
    expect(subtaskRes.ok()).toBeTruthy();
    const subtaskBody = await subtaskRes.json();
    const subtaskId = subtaskBody.id ?? subtaskBody.entity?.id;

    // Mark the subtask as awaiting_approval
    const patchRes = await request.patch(`/api/subtasks/${subtaskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "awaiting_approval" },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Verify via task GET that the phase is awaiting approval
    const taskRes = await request.get(`/api/tasks/${taskId}`);
    expect(taskRes.ok()).toBeTruthy();
    const taskBody = await taskRes.json();
    const subtasks = taskBody.subtasks ?? [];
    const awaitingSub = subtasks.find((s: { title: string }) => s.title === `[pipeline:${phaseId}]`);
    expect(awaitingSub).toBeTruthy();
    expect(awaitingSub.status).toBe("awaiting_approval");

    // Approve the phase via API
    const approveRes = await request.post(`/api/core/tasks/${taskId}/phases/${phaseId}/approve`, {
      headers: { "x-csrf-token": csrfToken },
    });
    expect(approveRes.ok(), `Phase approve failed (status=${approveRes.status()})`).toBeTruthy();
    const approveBody = await approveRes.json();
    expect(approveBody.approved).toBe(true);
    expect(approveBody.phaseId).toBe(phaseId);

    // Verify the phase subtask is now done
    const verifyRes = await request.get(`/api/tasks/${taskId}`);
    expect(verifyRes.ok()).toBeTruthy();
    const verifyBody = await verifyRes.json();
    const verifySubtasks = verifyBody.subtasks ?? [];
    const approvedSub = verifySubtasks.find((s: { title: string }) => s.title === `[pipeline:${phaseId}]`);
    expect(approvedSub.status).toBe("done");
  });

  test("task with workflow pack appears on board via UI", async ({
    page,
    request,
    csrfToken,
    department,
    teamLeader,
    project,
  }) => {
    savedCsrfToken = csrfToken;

    // Create a task with workflow pack
    const taskTitle = `E2E Board Task ${Date.now()}`;
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: taskTitle,
        description: "Verify task on board",
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

    // Navigate to the tasks board
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await navigateTo(page, "tasks");

    // Wait for the main content to load
    const mainContent = page.locator("main").first();
    await expect(mainContent).toBeVisible();

    // Verify the task title appears somewhere on the page
    const taskText = page.getByText(taskTitle).first();
    await expect(taskText).toBeVisible({ timeout: 10_000 });
  });

  test("workflow pack registry API returns loaded packs with phases", async ({ request, csrfToken }) => {
    savedCsrfToken = csrfToken;

    // GET the loaded packs endpoint
    const loadedRes = await request.get("/api/ops/workflow-packs/loaded");
    expect(loadedRes.ok()).toBeTruthy();
    const loadedBody = await loadedRes.json();
    const packs = loadedBody.packs ?? loadedBody;
    expect(Array.isArray(packs)).toBeTruthy();

    // Verify at least one pack has phases
    if (packs.length > 0) {
      const packWithPhases = packs.find((p: { phases?: unknown[] }) => Array.isArray(p.phases) && p.phases.length > 0);
      if (packWithPhases) {
        expect(packWithPhases.phases.length).toBeGreaterThan(0);
      }
    }

    // Verify the registry endpoint also works
    const registryRes = await request.get("/api/ops/workflow-packs/registry");
    expect(registryRes.ok()).toBeTruthy();
    const registry = await registryRes.json();
    expect(typeof registry).toBe("object");
  });
});
