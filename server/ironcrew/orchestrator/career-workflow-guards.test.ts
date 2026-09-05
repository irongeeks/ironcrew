import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { CompanyOrchestrator } from "./company.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
import { LEAD_ROUTING_MARKER, LEAD_REVIEW_MARKER } from "./career-workflow.ts";

class GuardRuntime extends StubRuntime {
  calls: string[] = [];
  selected = "";
  onCapabilities?: () => void;
  constructor() {
    super("mock");
  }
  capabilities() {
    this.onCapabilities?.();
    return super.capabilities();
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push(context.agentId!);
    yield stubEvent(context, "run.started");
    const text = input.prompt.includes(LEAD_ROUTING_MARKER)
      ? JSON.stringify({
          version: 1,
          assignedAgentId: this.selected,
          difficulty: "simple",
          rationale: "Passende Junior-Fachaufgabe",
        })
      : input.prompt.includes(LEAD_REVIEW_MARKER)
        ? JSON.stringify({
            version: 1,
            score: 4,
            rationale: "Kriterien erfüllt",
            rubricDimensions: { correctness: 4, completeness: 4, quality: 4 },
            evidence: [],
          })
        : "Arbeitsergebnis";
    yield stubEvent(context, "usage.updated", { costMicros: 10 });
    yield stubEvent(context, "message.completed", { text });
    yield stubEvent(context, "run.completed");
  }
}
let db: DatabaseSync, orc: CompanyOrchestrator, runtime: GuardRuntime;
let companyId: string, lead: string, junior: string, taskId: string;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({
    name: "Career guards",
    slug: "career-guards",
    crew: loadCrewConfig(),
    departments: loadDepartmentConfig(),
  });
  const agents = orc.listAgents(companyId);
  lead = agents.find((a) => a.key === "cto")!.id;
  junior = agents.find((a) => a.key === "research")!.id;
  const department = agents.find((a) => a.id === lead)!.department_id!;
  db.prepare("UPDATE crew_agents SET department_id=? WHERE id=?").run(department, junior);
  for (const [id, level] of [
    [lead, "lead"],
    [junior, "junior"],
  ])
    db.prepare(
      "INSERT INTO crew_career_levels(company_id,agent_id,revision,level,approval_id,created_at) VALUES(?,?,1,?,?,?)",
    ).run(companyId, id, level, `fixture-${id}`, Date.now());
  orc.career.updateConfig(
    companyId,
    {
      baseRevision: 0,
      enabled: true,
      departments: [{ departmentId: department, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: null }],
    },
    "ceo",
  );
  runtime = new GuardRuntime();
  runtime.selected = junior;
  orc.registerRuntime(runtime);
  taskId = orc.tasks.create({
    companyId,
    title: "Fachbericht",
    description: "Erstelle einen Bericht mit Quellen",
    status: "ready",
    assignedAgentId: junior,
    riskLevel: "low",
  }).id;
});
afterEach(() => db.close());
async function routed() {
  expect(await orc.executeTaskById(companyId, taskId)).toBeNull();
  const internal = orc.career.routingForTask(companyId, taskId)!.internalTaskId!;
  expect((await orc.executeTaskById(companyId, internal))?.task.status).toBe("done");
}
async function pendingReview() {
  await routed();
  const work = (await orc.executeTaskById(companyId, taskId))!;
  return orc.career.reviewForRun(companyId, work.runId)!.internalTaskId!;
}

describe("career execution boundary guards", () => {
  it("rechecks junior limits after asynchronous workspace/capability preparation", async () => {
    await routed();
    runtime.onCapabilities = () => {
      db.prepare("UPDATE crew_tasks SET risk_level='high',sensitive=1 WHERE id=?").run(taskId);
    };
    const result = await orc.executeTaskById(companyId, taskId);
    expect(result?.task.status).toBe("failed");
    expect(runtime.calls).toEqual([lead]);
  });

  it("keeps an existing task approval gate ahead of career routing and overrides", async () => {
    orc.approvals.request(
      companyId,
      { approvalType: "production_change", requestedBy: junior, summary: "Owner decision required" },
      { taskId },
    );
    expect(await orc.executeTaskById(companyId, taskId, { runtimeType: "mock" })).toBeNull();
    expect(runtime.calls).toEqual([]);
    expect(orc.career.routingForTask(companyId, taskId)).toBeNull();
  });

  it.each(["routing", "review"] as const)("refuses a demoted lead before a pending %s run", async (purpose) => {
    let internal: string;
    if (purpose === "review") internal = await pendingReview();
    else {
      await orc.executeTaskById(companyId, taskId);
      internal = orc.career.routingForTask(companyId, taskId)!.internalTaskId!;
    }
    const calls = [...runtime.calls];
    db.prepare(
      "INSERT INTO crew_career_levels(company_id,agent_id,revision,level,approval_id,created_at) VALUES(?,?,2,'junior','approved-demotion-fixture',?)",
    ).run(companyId, lead, Date.now());
    await orc.executeTaskById(companyId, internal);
    expect(runtime.calls).toEqual(calls);
  });

  it("refuses a reassigned internal lead task before any unapproved agent runtime is invoked", async () => {
    await orc.executeTaskById(companyId, taskId);
    const internal = orc.career.routingForTask(companyId, taskId)!.internalTaskId!;
    db.prepare("UPDATE crew_tasks SET assigned_agent_id=? WHERE id=?").run(junior, internal);
    await orc.executeTaskById(companyId, internal);
    expect(runtime.calls).toEqual([]);
    expect(orc.tasks.get(taskId)?.status).toBe("blocked");
  });
  it("prevents actual self-review after task reassignment and orchestrator restart", async () => {
    const internal = await pendingReview();
    expect(runtime.calls).toEqual([lead, junior]);
    db.prepare("UPDATE crew_tasks SET assigned_agent_id=? WHERE id=?").run(junior, internal);
    orc = new CompanyOrchestrator(db);
    orc.registerRuntime(runtime);
    await orc.executeTaskById(companyId, internal);
    expect(runtime.calls).toEqual([lead, junior]);
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });
  it("rechecks a junior's risk limit after routing, including direct runtime overrides", async () => {
    await routed();
    db.prepare("UPDATE crew_tasks SET risk_level='high',sensitive=1 WHERE id=?").run(taskId);
    await expect(orc.executeTaskById(companyId, taskId, { runtimeType: "mock" })).rejects.toThrow("Junior");
    expect(runtime.calls).toEqual([lead]);
  });
  it("does not execute a stale internal reviewer after career configuration is disabled", async () => {
    const internal = await pendingReview();
    const config = orc.career.config(companyId);
    orc.career.updateConfig(
      companyId,
      { baseRevision: config.revision, enabled: false, departments: config.departments },
      "ceo",
    );
    await orc.executeTaskById(companyId, internal);
    expect(runtime.calls).toEqual([lead, junior]);
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });
  it("charges review work to its root task and blocks the reviewer at an exhausted root budget", async () => {
    const internal = await pendingReview();
    const budget = orc.budgets.setBudget({ companyId, scopeType: "task", scopeId: taskId, limitMicros: 20 });
    expect(orc.budgets.spentFor(budget)).toBe(20);
    await expect(orc.executeTaskById(companyId, internal)).rejects.toThrow("Budget hard stop");
    expect(runtime.calls).toEqual([lead, junior]);
  });
});
