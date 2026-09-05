import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
import { PROJECT_PLANNING_MARKER, type ProjectPlan } from "../../../src/shared/project-planning.ts";
import { verifyAuditChain } from "../domain/audit.ts";

class PlanningRuntime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  output = "";
  constructor() {
    super("mock");
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "run.started");
    const text = input.prompt.includes(PROJECT_PLANNING_MARKER) ? this.output : "Ergebnis und Quellen bereit.";
    yield stubEvent(context, "message.completed", { text });
    yield stubEvent(context, "run.completed", { summary: text });
  }
}
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let runtime: PlanningRuntime;
let companyId: string;
let plan: ProjectPlan;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  runtime = new PlanningRuntime();
  orc.registerRuntime(runtime);
  companyId = orc.seedCompany({
    name: "Project Planning",
    slug: "planning-test",
    crew: loadCrewConfig(undefined, path.join(configDir(), "private", "__missing__.local.yaml")),
    departments: loadDepartmentConfig(),
  });
  const agents = orc.listAgents(companyId).filter((a) => !a.is_executive_assistant);
  plan = {
    version: 1,
    goal: "Geprüfte lokale Demo",
    scope: ["Lokale Implementierung"],
    nonGoals: ["Keine Produktion"],
    assumptions: ["Testdaten"],
    risks: ["Unbekannte Bestandsanforderungen"],
    deliverables: ["Demo und Testbericht"],
    approvalPoints: ["Produktion separat"],
    budgetMicros: 10_000_000,
    tasks: [
      {
        key: "build",
        title: "Demo bauen",
        description: "Lokale Demo implementieren und dokumentieren.",
        agentKey: agents[0].key,
        dependsOn: [],
        acceptanceCriteria: ["Build besteht"],
        riskLevel: "low",
      },
      {
        key: "review",
        title: "Demo prüfen",
        description: "Testbericht erstellen.",
        agentKey: agents[1].key,
        dependsOn: ["build"],
        acceptanceCriteria: ["Testbericht liegt vor"],
        riskLevel: "low",
      },
    ],
  };
  runtime.output = JSON.stringify(plan);
});
afterEach(() => db.close());
function submit() {
  return orc.handleCeoMessage(
    companyId,
    "Wir starten ein Projekt für eine lokale Demo und danach eine dokumentierte Prüfung.",
  );
}
async function readyPlan() {
  const received = submit();
  expect(received.triage.category).toBe("project");
  const result = await orc.executeNextTask(companyId);
  expect(result?.task.status).toBe("review");
  return { received, result: result! };
}
describe("CEO project planning to approved canonical task tree", () => {
  it("runs EA planning first, then creates attributed child tasks, dependencies and budget only after owner review", async () => {
    const received = submit();
    const task = received.task!;
    expect(received.assignedAgent?.is_executive_assistant).toBe(1);
    expect(orc.tasks.list(companyId)).toHaveLength(1);
    expect(orc.projectPlans.forTask(companyId, task.id)?.status).toBe("planning");
    const completed = await orc.executeNextTask(companyId);
    expect(completed?.task.status).toBe("review");
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0].input.prompt).toContain(PROJECT_PLANNING_MARKER);
    expect(orc.tasks.list(companyId)).toHaveLength(1);
    expect(orc.projectPlans.forTask(companyId, task.id)).toMatchObject({
      status: "review",
      run_id: completed!.runId,
      plan,
    });
    expect(() => orc.acceptReview(companyId, task.id)).toThrow("Planfreigabe");
    const children = orc.reviewProjectPlan(companyId, task.id, "approved");
    expect(children).toHaveLength(2);
    expect(orc.tasks.get(task.id)?.status).toBe("done");
    expect(children.every((child) => child.project_id === task.project_id && child.parent_task_id === task.id)).toBe(
      true,
    );
    const build = children.find((child) => child.title === "Demo bauen")!;
    const review = children.find((child) => child.title === "Demo prüfen")!;
    expect(build.assigned_agent_id).toBe(orc.getAgent(companyId, plan.tasks[0].agentKey)?.id);
    expect(orc.tasks.blockers(review.id).map((t) => t.id)).toEqual([build.id]);
    expect(orc.tasks.isDependencyReady(review.id)).toBe(false);
    expect(JSON.parse(review.acceptance_criteria)).toEqual(["Testbericht liegt vor"]);
    expect(
      db
        .prepare("SELECT limit_micros FROM crew_budgets WHERE company_id=? AND scope_type='project' AND scope_id=?")
        .get(companyId, task.project_id),
    ).toMatchObject({ limit_micros: 10_000_000 });
    expect(() => orc.reviewProjectPlan(companyId, task.id, "approved")).toThrow("nicht zur Freigabe bereit");
    expect(orc.tasks.list(companyId)).toHaveLength(3);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
  it("retains a reviewable plan across restart and rejects without creating or scheduling children", async () => {
    const { received } = await readyPlan();
    const restarted = new CompanyOrchestrator(db);
    expect(restarted.projectPlans.forTask(companyId, received.task!.id)?.plan).toEqual(plan);
    expect(restarted.reviewProjectPlan(companyId, received.task!.id, "rejected")).toEqual([]);
    expect(restarted.tasks.get(received.task!.id)?.status).toBe("cancelled");
    expect(restarted.projectPlans.forTask(companyId, received.task!.id)?.status).toBe("rejected");
    expect(restarted.tasks.list(companyId)).toHaveLength(1);
    expect(await restarted.executeNextTask(companyId)).toBeNull();
  });
  it.each(["invalid-json", "unknown-agent", "cycle"])("fails safely for %s from a real planning run", async (kind) => {
    if (kind === "invalid-json") runtime.output = "Dies ist kein JSON-Plan.";
    if (kind === "unknown-agent") {
      plan.tasks[0].agentKey = "not-an-agent";
      runtime.output = JSON.stringify(plan);
    }
    if (kind === "cycle") {
      plan.tasks[0].dependsOn = ["review"];
      runtime.output = JSON.stringify(plan);
    }
    const received = submit();
    const result = await orc.executeNextTask(companyId);
    expect(result?.task.status).toBe("failed");
    expect(orc.projectPlans.forTask(companyId, received.task!.id)?.status).toBe("failed");
    expect(() => orc.reviewProjectPlan(companyId, received.task!.id, "approved")).toThrow("nicht zur Freigabe bereit");
    expect(orc.tasks.list(companyId)).toHaveLength(1);
  });
  it("a low model risk label cannot authorize a payment or remove the independent action gate", async () => {
    plan.tasks[0].title = "Zahlung bearbeiten";
    plan.tasks[0].description = "Bitte überweise 500 EUR an den Dienstleister.";
    runtime.output = JSON.stringify(plan);
    const { received } = await readyPlan();
    const children = orc.reviewProjectPlan(companyId, received.task!.id, "approved");
    const risky = children.find((c) => c.title === "Zahlung bearbeiten")!;
    expect(risky.status).toBe("approval_required");
    expect(risky.sensitive).toBe(1);
    expect(db.prepare("SELECT status,approval_type FROM crew_approvals WHERE task_id=?").get(risky.id)).toMatchObject({
      status: "pending",
    });
    expect(runtime.calls).toHaveLength(1);
  });
  it("prevents foreign-company review and atomically rolls back if child creation fails", async () => {
    const { received } = await readyPlan();
    const other = seedCompany(db, "Other");
    expect(() => orc.reviewProjectPlan(other, received.task!.id, "approved")).toThrow("nicht zur Freigabe bereit");
    db.exec(
      "CREATE TRIGGER fail_plan_child BEFORE INSERT ON crew_tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'child persistence failed'); END;",
    );
    expect(() => orc.reviewProjectPlan(companyId, received.task!.id, "approved")).toThrow("child persistence failed");
    expect(orc.projectPlans.forTask(companyId, received.task!.id)?.status).toBe("review");
    expect(orc.tasks.get(received.task!.id)?.status).toBe("review");
    expect(orc.tasks.list(companyId)).toHaveLength(1);
  });
});
