import { afterEach, beforeEach, describe, it, expect } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunInput, RunContext } from "../runtime/run-events.ts";
import { LEAD_ROUTING_MARKER, LEAD_REVIEW_MARKER } from "./career-workflow.ts";
import type { Difficulty } from "../../../src/shared/career.ts";
class LeadFixtureRuntime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  selected = "";
  difficulty: Difficulty = "simple";
  score = 4;
  cost = 10;
  invalidRouting = false;
  invalidReview = false;
  completed = true;
  constructor() {
    super("mock");
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "run.started");
    yield stubEvent(context, "usage.updated", { costMicros: this.cost });
    let text = "Nachvollziehbares Arbeitsergebnis mit Quellen.";
    if (input.prompt.includes(LEAD_ROUTING_MARKER))
      text = this.invalidRouting
        ? "invalid-json"
        : JSON.stringify({
            version: 1,
            assignedAgentId: this.selected,
            difficulty: this.difficulty,
            rationale: "Fixture des tatsächlich ausgeführten Lead-Runs: passende Fachaufgabe und Erfahrungsstufe.",
          });
    if (input.prompt.includes(LEAD_REVIEW_MARKER))
      text = JSON.stringify({
        version: 1,
        score: this.invalidReview ? 9 : this.score,
        rationale: "Fixture-Review: Kriterien erfüllt, ein Quellenverweis benötigt Präzisierung.",
        rubricDimensions: { correctness: 4, completeness: 4, quality: 4 },
        evidence: ["Run-Ergebnis mit Quellenabschnitt"],
      });
    yield stubEvent(context, "message.completed", { text });
    if (this.completed) yield stubEvent(context, "run.completed");
  }
}
let db: DatabaseSync,
  orc: CompanyOrchestrator,
  runtime: LeadFixtureRuntime,
  companyId: string,
  dept: string,
  lead: string,
  junior: string,
  senior: string,
  coo: string,
  taskId: string;
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__missing__.yaml"));
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Hierarchy", slug: "hierarchy", crew, departments: loadDepartmentConfig() });
  const agents = orc.listAgents(companyId);
  lead = agents.find((a) => a.key === "cto")!.id;
  dept = agents.find((a) => a.id === lead)!.department_id!;
  junior = agents.find((a) => a.key === "knowledge")?.id ?? agents.find((a) => a.key === "research")!.id;
  senior = agents.find((a) => a.key === "infra")!.id;
  coo = agents.find((a) => a.key === "coo")!.id;
  db.prepare("UPDATE crew_agents SET department_id=? WHERE id IN (?,?)").run(dept, junior, senior);
  for (const [agent, level] of [
    [lead, "lead"],
    [junior, "junior"],
    [senior, "senior"],
  ])
    db.prepare(
      "INSERT INTO crew_career_levels(company_id,agent_id,revision,level,approval_id,created_at) VALUES (?,?,1,?,?,?)",
    ).run(companyId, agent, level, `approved-fixture-${agent}`, Date.now());
  orc.career.updateConfig(
    companyId,
    {
      baseRevision: 0,
      enabled: true,
      departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: coo }],
    },
    "ceo",
  );
  runtime = new LeadFixtureRuntime();
  runtime.selected = junior;
  orc.registerRuntime(runtime);
  const route = orc.routing.current(companyId);
  const vessel = agents.find((a) => a.id === lead)!.vessel_id!;
  for (const [key, model] of [
    ["coding", "lead-model"],
    ["balanced", "worker-model"],
  ])
    Object.assign(route.config.profiles.find((p) => p.key === key)!, {
      primary: { vesselId: vessel, runtimeType: "mock", model, vendorModel: `openai/${model}` },
      allowedSensitivity: ["internal", "confidential"],
    });
  orc.routing.save(companyId, { expectedRevision: route.revision, config: route.config }, "ceo");
  orc.routing.bind(companyId, lead, { profileKey: "coding" }, "ceo");
  orc.routing.bind(companyId, junior, { profileKey: "balanced" }, "ceo");
  orc.routing.bind(companyId, senior, { profileKey: "balanced" }, "ceo");
  taskId = orc.tasks.create({
    companyId,
    title: "Bericht prüfen",
    description: "Erstelle einen fachlich nachvollziehbaren Bericht.",
    status: "ready",
    assignedAgentId: junior,
    riskLevel: "low",
    acceptanceCriteria: ["Quellen nennen"],
  }).id;
});
afterEach(() => db.close());
async function routeOnly() {
  expect(await orc.executeTaskById(companyId, taskId)).toBeNull();
  const link = orc.career.routingForTask(companyId, taskId)!;
  const result = await orc.executeTaskById(companyId, link.internalTaskId!);
  return result!;
}
async function workOnly() {
  await routeOnly();
  return (await orc.executeTaskById(companyId, taskId))!;
}
describe("real department lead routing and review runs", () => {
  it.each(["routing", "review"])("revalidates company restrictions before an internal lead %s run", async (phase) => {
    let internalTaskId: string;
    if (phase === "review") {
      const work = await workOnly();
      internalTaskId = orc.career.reviewForRun(companyId, work.runId)!.internalTaskId!;
    } else {
      await orc.executeTaskById(companyId, taskId);
      internalTaskId = orc.career.routingForTask(companyId, taskId)!.internalTaskId!;
    }
    const before = runtime.calls.length;
    const current = orc.companyPolicies.snapshot(companyId);
    orc.companyPolicies.save(
      companyId,
      {
        baseRevision: current.revision,
        baselineFingerprint: current.baselineFingerprint,
        reason: "OpenAI-Routen bis zur nächsten Freigabe sperren.",
        restrictions: { ...current.restrictions, allowedFamilies: ["anthropic/*"] },
      },
      "ceo",
    );
    await expect(orc.executeTaskById(companyId, internalTaskId)).rejects.toThrow("Vendor-Policy");
    expect(runtime.calls).toHaveLength(before);
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });

  it("executes lead assignment, junior work, and independent review through persisted model profiles", async () => {
    orc.enqueueRun(companyId, taskId);
    await orc.drainRunQueue(companyId, { limit: 10 });
    expect(runtime.calls.map((c) => c.context.agentId)).toEqual([lead, junior, lead]);
    expect(runtime.calls.map((c) => c.input.model)).toEqual(["lead-model", "worker-model", "lead-model"]);
    expect(runtime.calls[0].context).toMatchObject({ permissionMode: "restricted", allowedTools: [] });
    expect(runtime.calls[2].context.allowedTools).toEqual([]);
    expect(orc.tasks.get(taskId)?.status).toBe("review");
    const snapshot = orc.career.snapshot(companyId);
    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.reviews[0]).toMatchObject({
      agentId: junior,
      reviewerAgentId: lead,
      score: 4,
      model: "worker-model",
      isCurrent: true,
      difficulty: "simple",
    });
    expect(db.prepare("SELECT SUM(cost_micros) AS n FROM crew_cost_events WHERE company_id=?").get(companyId)).toEqual({
      n: 30,
    });
    const budget = orc.budgets.setBudget({ companyId, scopeType: "task", scopeId: taskId, limitMicros: 100 });
    expect(orc.budgets.spentFor(budget)).toBe(30);
  });
  it("routes complex work to a senior with a persisted explanation", async () => {
    runtime.selected = senior;
    runtime.difficulty = "complex";
    await routeOnly();
    expect(orc.tasks.get(taskId)?.assigned_agent_id).toBe(senior);
    expect(orc.career.routingForTask(companyId, taskId)).toMatchObject({ difficulty: "complex", status: "completed" });
    await orc.executeTaskById(companyId, taskId);
    expect(runtime.calls[1].context.agentId).toBe(senior);
  });
  it.each(["complex", "normal"] as const)(
    "rejects a lead decision assigning %s work to a junior",
    async (difficulty) => {
      runtime.difficulty = difficulty;
      const routing = await routeOnly();
      expect(routing.task.status).toBe("failed");
      expect(orc.tasks.get(taskId)?.status).toBe("blocked");
      expect(runtime.calls).toHaveLength(1);
    },
  );
  it("does not reinterpret invalid lead output as heuristic delegation", async () => {
    runtime.invalidRouting = true;
    const routing = await routeOnly();
    expect(routing.task.status).toBe("failed");
    expect(orc.career.routingForTask(companyId, taskId)?.status).toBe("failed");
    expect(orc.tasks.get(taskId)?.status).toBe("blocked");
  });
  it("allows one explicit owner retry after invalid routing without a hidden automatic loop", async () => {
    runtime.invalidRouting = true;
    const failed = await routeOnly();
    const link = orc.career.routingForTask(companyId, taskId)!;
    expect(failed.task.status).toBe("failed");
    runtime.invalidRouting = false;
    expect(orc.requestRevision(companyId, link.internalTaskId!, "JSONschema beachten")?.status).toBe("ready");
    await orc.executeTaskById(companyId, link.internalTaskId!);
    expect(orc.career.routingForTask(companyId, taskId)?.status).toBe("completed");
    expect(orc.tasks.get(taskId)?.status).toBe("ready");
    expect(runtime.calls).toHaveLength(2);
  });
  it("blocks foreign-department assignment and produces no work run", async () => {
    runtime.selected = coo;
    const routing = await routeOnly();
    expect(routing.task.status).toBe("failed");
    expect(orc.runs.listForTask(taskId)).toHaveLength(0);
  });
  it("runs pending review after orchestrator restart even if the owner already accepted work", async () => {
    const work = await workOnly();
    const link = orc.career.reviewForRun(companyId, work.runId)!;
    expect(link.status).toBe("pending");
    expect(orc.acceptReview(companyId, taskId)?.status).toBe("done");
    orc = new CompanyOrchestrator(db);
    orc.registerRuntime(runtime);
    await orc.executeTaskById(companyId, link.internalTaskId!);
    expect(orc.career.snapshot(companyId).reviews[0]).toMatchObject({
      score: 4,
      workRunId: work.runId,
      isCurrent: true,
    });
    expect(orc.tasks.get(taskId)?.status).toBe("done");
  });
  it("uses the explicit neutral COO for the lead’s own work, never self-review", async () => {
    runtime.selected = lead;
    runtime.difficulty = "complex";
    const work = await workOnly();
    const review = orc.career.reviewForRun(companyId, work.runId)!;
    expect(review.reviewerAgentId).toBe(coo);
    await orc.executeTaskById(companyId, review.internalTaskId!);
    expect(orc.career.snapshot(companyId).reviews[0]).toMatchObject({ agentId: lead, reviewerAgentId: coo });
  });
  it("records owner review required with no invented stars when neutral reviewer is absent", async () => {
    const config = orc.career.snapshot(companyId).config;
    orc.career.updateConfig(
      companyId,
      {
        baseRevision: config.revision,
        enabled: true,
        departments: [{ departmentId: dept, enabled: true, leadAgentId: lead, fallbackReviewerAgentId: null }],
      },
      "ceo",
    );
    runtime.selected = lead;
    const work = await workOnly();
    expect(orc.career.reviewForRun(companyId, work.runId)).toMatchObject({
      status: "owner_required",
      internalTaskId: null,
    });
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });
  it("does not record malformed ratings or start automatic review loops", async () => {
    const work = await workOnly();
    runtime.invalidReview = true;
    const review = orc.career.reviewForRun(companyId, work.runId)!;
    const result = await orc.executeTaskById(companyId, review.internalTaskId!);
    expect(result?.task.status).toBe("failed");
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
    expect(runtime.calls).toHaveLength(3);
  });
  it("counts only the latest completed work run’s review while preserving old ratings and model snapshots", async () => {
    const first = await workOnly();
    await orc.executeTaskById(companyId, orc.career.reviewForRun(companyId, first.runId)!.internalTaskId!);
    orc.requestRevision(companyId, taskId, "Bitte präzisieren");
    const route = orc.routing.current(companyId);
    route.config.profiles.find((p) => p.key === "balanced")!.primary!.model = "worker-next";
    route.config.profiles.find((p) => p.key === "balanced")!.primary!.vendorModel = "openai/worker-next";
    orc.routing.save(companyId, { expectedRevision: route.revision, config: route.config }, "ceo");
    // A changed owner model mapping is an explicit new route; remove old route pin by choosing a new abstract profile.
    orc.routing.bind(companyId, junior, { profileKey: "coding" }, "ceo");
    const next = await orc.executeTaskById(companyId, taskId);
    expect(next?.task.status).toBe("review");
    runtime.score = 5;
    await orc.executeTaskById(companyId, orc.career.reviewForRun(companyId, next!.runId)!.internalTaskId!);
    const ratings = orc.career.snapshot(companyId);
    expect(ratings.reviews).toHaveLength(2);
    expect(ratings.reviews.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(ratings.aggregates.agents.find((a) => a.key === junior)).toMatchObject({ count: 1, mean: 5 });
    expect(ratings.reviews.find((r) => r.workRunId === first.runId)?.model).toBe("worker-model");
  });
  it("stops paid lead activity at the original task hard stop", async () => {
    orc.budgets.setBudget({ companyId, scopeType: "task", scopeId: taskId, limitMicros: 10 });
    const routing = await routeOnly();
    expect(routing.task.status).toBe("failed");
    expect(orc.runs.listForTask(taskId)).toHaveLength(0);
    expect(orc.career.routingForTask(companyId, taskId)?.status).toBe("failed");
  });
  it("does not retroactively route an existing queued task when leadership is re-enabled", async () => {
    const config = orc.career.config(companyId);
    orc.career.updateConfig(
      companyId,
      { baseRevision: config.revision, enabled: false, departments: config.departments },
      "ceo",
    );
    const disabled = orc.career.config(companyId);
    orc.career.updateConfig(
      companyId,
      { baseRevision: disabled.revision, enabled: true, departments: disabled.departments },
      "ceo",
    );
    await orc.executeTaskById(companyId, taskId);
    expect(runtime.calls).toHaveLength(1);
    expect(orc.career.routingForTask(companyId, taskId)).toBeNull();
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });
  it("preserves legacy execution when the hierarchy is disabled", async () => {
    const config = orc.career.snapshot(companyId).config;
    orc.career.updateConfig(
      companyId,
      { baseRevision: config.revision, enabled: false, departments: config.departments },
      "ceo",
    );
    await orc.executeTaskById(companyId, taskId);
    expect(runtime.calls).toHaveLength(1);
    expect(orc.career.routingForTask(companyId, taskId)).toBeNull();
    expect(orc.career.snapshot(companyId).reviews).toEqual([]);
  });
});
