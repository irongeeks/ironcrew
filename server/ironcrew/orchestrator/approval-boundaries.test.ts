import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import type { ProjectPlan } from "../../../src/shared/project-planning.ts";
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Plan boundaries", slug: "plan-boundaries" });
});
afterEach(() => db.close());
async function prepare(budgetMicros = 1000000, highRisk = false) {
  const project = orc.projects.create({ companyId, title: "Plan project" });
  const task = orc.tasks.create({
    companyId,
    projectId: project.id,
    title: "Plan",
    assignedAgentId: orc.getAgent(companyId, "cto")!.id,
    status: "ready",
  });
  const plan: ProjectPlan = {
    version: 1,
    goal: "Reviewable project",
    scope: ["Prepare result"],
    nonGoals: [],
    assumptions: [],
    risks: [],
    deliverables: ["Report"],
    approvalPoints: [],
    budgetMicros,
    tasks: [
      {
        key: "analysis",
        title: highRisk ? "Produktives Deployment" : "Analyse",
        description: highRisk ? "Deployment auf das produktive System durchführen" : "Dokumentation analysieren",
        agentKey: "cto",
        dependsOn: [],
        acceptanceCriteria: ["Reviewed result"],
        riskLevel: "low",
      },
    ],
  };
  orc.projectPlans.create(companyId, project.id, task.id, "ceo");
  orc.registerRuntime(new MockRuntime({ responseText: JSON.stringify(plan) }));
  await orc.executeNextTask(companyId);
  return { task, project };
}
describe("project approval and generic status boundaries", () => {
  it("does not turn an unknown zero plan budget into unlimited delegated spend", async () => {
    const { task, project } = await prepare(0);
    expect(() => orc.reviewProjectPlan(companyId, task.id, "approved")).toThrow(/Budget/i);
    expect(orc.tasks.list(companyId).filter((child) => child.parent_task_id === task.id)).toHaveLength(0);
    expect(orc.projectPlans.forTask(companyId, task.id)?.status).toBe("review");
    orc.budgets.setBudget({
      companyId,
      scopeType: "project",
      scopeId: project.id,
      limitMicros: 1000000,
      hardStop: true,
    });
    expect(orc.reviewProjectPlan(companyId, task.id, "approved")).toHaveLength(1);
  });
  it("enforces a positive approved plan cap even if a prior project budget was disabled or looser", async () => {
    const { task, project } = await prepare(1000000);
    orc.budgets.setBudget({
      companyId,
      scopeType: "project",
      scopeId: project.id,
      limitMicros: 5000000,
      hardStop: false,
    });
    orc.reviewProjectPlan(companyId, task.id, "approved");
    expect(
      db
        .prepare(
          "SELECT limit_micros, hard_stop FROM crew_budgets WHERE company_id=? AND scope_type='project' AND scope_id=? AND active=1",
        )
        .get(companyId, project.id),
    ).toMatchObject({ limit_micros: 1000000, hard_stop: 1 });
  });
  it("does not publish approval notifications for a transaction that rolls back", async () => {
    const { task } = await prepare(1000000, true);
    const send = vi.fn(async () => {});
    orc.registerNotificationChannel({
      kind: "offline-fixture",
      send,
      testConnection: async () => ({ ok: true, message: "fixture" }),
    });
    db.exec(
      `CREATE TRIGGER prevent_plan_completion BEFORE UPDATE OF status ON crew_tasks WHEN NEW.id='${task.id}' AND NEW.status='done' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END`,
    );
    expect(() => orc.reviewProjectPlan(companyId, task.id, "approved")).toThrow(/fixture commit failure/);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(orc.projectPlans.forTask(companyId, task.id)?.status).toBe("review");
    expect(orc.tasks.list(companyId).filter((child) => child.parent_task_id === task.id)).toHaveLength(0);
    expect(orc.approvals.listPending(companyId)).toHaveLength(0);
  });
  it("does not let generic status or result acceptance bypass a separate high-risk approval", async () => {
    const { task } = await prepare(1000000, true);
    const [child] = orc.reviewProjectPlan(companyId, task.id, "approved");
    expect(child.status).toBe("approval_required");
    for (const status of ["ready", "running", "review", "done"] as const)
      await expect(orc.changeTaskStatus(companyId, child.id, status, "bypass")).rejects.toThrow(/Freigabe/);
    expect(orc.acceptReview(companyId, child.id)).toBeNull();
    expect(orc.requestRevision(companyId, child.id, "Freigabe umgehen")).toBeNull();
    expect(orc.tasks.get(child.id)?.status).toBe("approval_required");
    expect(await orc.executeNextTask(companyId)).toBeNull();
  });
  it("keeps plan approval scoped and idempotent, and cannot be completed through ordinary review", async () => {
    const { task } = await prepare();
    expect(() => orc.reviewProjectPlan("foreign", task.id, "approved")).toThrow();
    expect(() => orc.acceptReview(companyId, task.id)).toThrow(/Planfreigabe/);
    await expect(orc.changeTaskStatus(companyId, task.id, "done", "skip")).rejects.toThrow(/Planfreigabe/);
    expect(orc.reviewProjectPlan(companyId, task.id, "approved")).toHaveLength(1);
    expect(() => orc.reviewProjectPlan(companyId, task.id, "approved")).toThrow();
    expect(orc.tasks.list(companyId).filter((child) => child.parent_task_id === task.id)).toHaveLength(1);
  });
});
