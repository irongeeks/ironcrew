/**
 * Actual API + browser project-plan acceptance on MockRuntime.
 * No database reset: unique project/vessel, scoped assertions and restoration of
 * only this test's agent bindings. The shared E2E server runs with workers: 1.
 * Do not parallelize this shared-company spec without a separate server/database.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { Agent } from "../../../src/ironcrew/types";
import type { ProjectPlanRecord } from "../../../src/shared/project-planning";

interface PlanTask {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  acceptance_criteria: string;
}

test("CEO plan is reviewed before its canonical child tasks exist", async ({ page, request }, testInfo) => {
  const headers = { "x-csrf-token": await establishSession(request) };
  const suffix = randomUUID().slice(0, 12);
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "read crew");
  const ea = agents.find((agent) => agent.isExecutiveAssistant)!;
  expect(ea).toBeTruthy();
  const selected = agents.filter((agent) => agent.id === ea.id || ["cto", "qa"].includes(agent.key));
  expect(selected.every((agent) => agent.vesselId)).toBe(true);
  const { vessel } = await expectOkJson<{ vessel: { id: string } }>(
    await request.post("/api/crew/vessels", {
      headers,
      data: { key: `e2e-plan-${suffix}`, label: "E2E planning mock only", runtimeProvider: "mock", maxRetries: 0 },
    }),
    "create isolated mock vessel",
  );
  let projectId: string | null = null;
  try {
    for (const agent of selected) {
      const bound = await request.post(`/api/crew/agents/${agent.id}/pairing`, {
        headers,
        data: { vesselId: vessel.id },
      });
      expect(bound.ok()).toBe(true);
    }
    const { project } = await expectOkJson<{ project: { id: string } }>(
      await request.post("/api/crew/projects", {
        headers,
        data: {
          title: `E2E Plan ${suffix}`,
          summary: "Isolated MockRuntime acceptance; no real account or external action.",
          workspacePath: `/tmp/ironcrew-e2e-plan-${suffix}`,
        },
      }),
      "create project",
    );
    projectId = project.id;
    const created = await expectOkJson<{ task: PlanTask; triage: { category: string } }>(
      await request.post("/api/crew/chat", {
        headers,
        data: {
          projectId,
          body: `Wir starten ein Projekt für eine lokale Demo und danach eine dokumentierte Prüfung. Referenz ${suffix}.`,
        },
      }),
      "send project request to EA",
    );
    expect(created.triage.category).toBe("project");
    expect(created.task.project_id).toBe(projectId);
    const planningTaskId = created.task.id;
    const initial = await expectOkJson<{ tasks: PlanTask[] }>(
      await request.get(`/api/crew/projects/${projectId}`),
      "initial project tasks",
    );
    expect(initial.tasks.map((task) => task.id)).toEqual([planningTaskId]);

    // Other sequential specs may leave queued MockRuntime tasks. Drain a bounded
    // amount and identify OUR task, never mistake the next unrelated result for it.
    let planningState = "ready";
    for (let step = 0; step < 40; step++) {
      const detail = await expectOkJson<{ task: PlanTask }>(
        await request.get(`/api/crew/tasks/${planningTaskId}`),
        "planning task state",
      );
      planningState = detail.task.status;
      if (["review", "failed", "cancelled"].includes(planningState)) break;
      await expectOkJson(await request.post("/api/crew/tasks/execute-next", { headers }), "execute next mock task");
    }
    expect(planningState).toBe("review");
    const { plans } = await expectOkJson<{ plans: ProjectPlanRecord[] }>(
      await request.get("/api/crew/project-plans"),
      "persisted project plans",
    );
    const plan = plans.find((item) => item.task_id === planningTaskId)!;
    expect(plan).toMatchObject({ project_id: projectId, status: "review", run_id: expect.any(String) });
    expect(plan.plan?.tasks.length).toBeGreaterThan(1);
    const beforeApproval = await expectOkJson<{ tasks: PlanTask[] }>(
      await request.get(`/api/crew/projects/${projectId}`),
      "tasks before approval",
    );
    expect(beforeApproval.tasks).toHaveLength(1);
    const normalAccept = await request.post(`/api/crew/tasks/${planningTaskId}/accept`, {
      headers,
      data: { note: "No plan bypass" },
    });
    expect(normalAccept.ok()).toBe(false);

    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.goto("/");
    await page.getByTestId("open-project-plans").click();
    const card = page.locator(".project-plan").filter({ hasText: projectId });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { name: plan.plan!.goal, exact: true })).toBeVisible();
    for (const scope of plan.plan!.scope) await expect(card.getByText(scope, { exact: true })).toBeVisible();
    for (const task of plan.plan!.tasks)
      await expect(card.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath("project-plan-before-approval.png") });
    const approvedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/crew/project-plans/${planningTaskId}/review`),
    );
    await card.getByRole("button", { name: "Plan freigeben", exact: true }).click();
    const accepted = await expectOkJson<{ tasks: PlanTask[] }>(await approvedResponse, "approve reviewed plan");
    expect(accepted.tasks).toHaveLength(plan.plan!.tasks.length);
    const childrenByTitle = new Map(accepted.tasks.map((task) => [task.title, task]));
    for (const step of plan.plan!.tasks) {
      const child = childrenByTitle.get(step.title)!;
      expect(child).toMatchObject({ project_id: projectId, parent_task_id: planningTaskId });
      expect(JSON.parse(child.acceptance_criteria)).toEqual(step.acceptanceCriteria);
      expect(child.assigned_agent_id).toBe(agents.find((agent) => agent.key === step.agentKey)!.id);
      const detail = await expectOkJson<{ blockers: PlanTask[] }>(
        await request.get(`/api/crew/tasks/${child.id}`),
        "child dependencies",
      );
      const expectedBlockers = step.dependsOn.map(
        (key) => childrenByTitle.get(plan.plan!.tasks.find((task) => task.key === key)!.title)!.id,
      );
      expect(detail.blockers.map((task) => task.id).sort()).toEqual(expectedBlockers.sort());
    }
    await expect(card.getByRole("button", { name: "Plan freigeben", exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByTestId("open-project-plans").click();
    await expect(
      page
        .locator(".project-plan")
        .filter({ hasText: projectId })
        .getByText(/Plan freigegeben ·/),
    ).toBeVisible();
    const again = await request.post(`/api/crew/project-plans/${planningTaskId}/review`, {
      headers,
      data: { decision: "approved" },
    });
    expect(again.ok()).toBe(false);
    const persisted = await expectOkJson<{ tasks: PlanTask[] }>(
      await request.get(`/api/crew/projects/${projectId}`),
      "persisted children",
    );
    expect(persisted.tasks).toHaveLength(plan.plan!.tasks.length + 1);
    const audit = await expectOkJson<{ chain: { valid: boolean } }>(
      await request.get("/api/crew/audit"),
      "audit chain",
    );
    expect(audit.chain.valid).toBe(true);
  } finally {
    // Preserve evidence, cancel only our unfinished tasks, restore original
    // bindings. Never clear shared tasks, budgets, approvals or company state.
    if (projectId) {
      const current = await expectOkJson<{ tasks: PlanTask[] }>(
        await request.get(`/api/crew/projects/${projectId}`),
        "cleanup own project",
      );
      for (const task of current.tasks.filter((task) => !["done", "cancelled"].includes(task.status))) {
        const cancelled = await request.post(`/api/crew/tasks/${task.id}/status`, {
          headers,
          data: { status: "cancelled", reason: "E2E test cleanup of own project" },
        });
        expect(cancelled.ok()).toBe(true);
      }
    }
    for (const agent of selected) {
      const restored = await request.post(`/api/crew/agents/${agent.id}/pairing`, {
        headers,
        data: { vesselId: agent.vesselId },
      });
      expect(restored.ok()).toBe(true);
    }
    const removed = await request.delete(`/api/crew/vessels/${vessel.id}`, { headers });
    expect(removed.ok()).toBe(true);
  }
});
