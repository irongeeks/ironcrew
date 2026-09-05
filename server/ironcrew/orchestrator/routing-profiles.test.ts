import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunInput, RunContext } from "../runtime/run-events.ts";
import type { RoutingProfile, RouteTarget } from "../../../src/shared/routing-profiles.ts";

class Runtime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  online = true;
  streaming = true;
  workspaceRequired = false;
  failure = false;
  incomplete = false;
  cost = 0;
  afterUsage = false;
  override async capabilities() {
    return { ...(await super.capabilities()), streaming: this.streaming, workspaceRequired: this.workspaceRequired };
  }
  override async healthCheck() {
    return { ...(await super.healthCheck()), healthy: this.online };
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "run.started");
    if (this.cost) {
      yield stubEvent(context, "usage.updated", { costMicros: this.cost });
      this.afterUsage = true;
    }
    if (this.failure) yield stubEvent(context, "run.failed", { message: "test failure" });
    else {
      yield stubEvent(context, "message.completed", { text: "Reviewed output" });
      if (!this.incomplete) yield stubEvent(context, "run.completed");
    }
  }
}
let db: DatabaseSync, orc: CompanyOrchestrator, companyId: string, agentId: string, taskId: string;
let primary: Runtime, fallback: Runtime, primaryTarget: RouteTarget, fallbackTarget: RouteTarget;
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Routing", slug: "routing", crew, departments: loadDepartmentConfig() });
  agentId = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!.id;
  taskId = orc.tasks.create({
    companyId,
    title: "Review routing",
    status: "ready",
    assignedAgentId: agentId,
    sensitive: false,
  }).id;
  primary = new Runtime("claude");
  fallback = new Runtime("codex");
  orc.registerRuntime(primary);
  orc.registerRuntime(fallback);
  const vessel = (runtimeProvider: string) =>
    orc.vessels.create({ companyId, key: runtimeProvider, runtimeProvider, maxConcurrency: 1 });
  primaryTarget = {
    vesselId: vessel("claude").id,
    runtimeType: "claude",
    model: "routing-example",
    vendorModel: "anthropic/routing-example",
  };
  fallbackTarget = {
    vesselId: vessel("codex").id,
    runtimeType: "codex",
    model: "routing-example",
    vendorModel: "openai/routing-example",
  };
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});
function configure(patch: Partial<RoutingProfile> = {}) {
  const current = orc.routing.current(companyId);
  const config = structuredClone(current.config);
  Object.assign(
    config.profiles.find((p) => p.key === "coding")!,
    {
      primary: primaryTarget,
      fallbacks: [fallbackTarget],
      allowFallback: true,
      allowedSensitivity: ["internal", "confidential"],
      requiredCapabilities: ["streaming"],
    },
    patch,
  );
  orc.routing.save(companyId, { expectedRevision: current.revision, config }, "ceo");
  orc.routing.bind(companyId, agentId, { profileKey: "coding" }, "ceo");
}
describe("persisted profile dispatch", () => {
  it("revalidates saved profiles against company policy and never falls back around denial", async () => {
    configure();
    const current = orc.companyPolicies.snapshot(companyId);
    orc.companyPolicies.save(
      companyId,
      {
        baseRevision: current.revision,
        baselineFingerprint: current.baselineFingerprint,
        reason: "Nur OpenAI für neue Ausführungen freigeben.",
        restrictions: { ...current.restrictions, allowedFamilies: ["openai/*"] },
      },
      "ceo",
    );
    await expect(orc.executeTaskById(companyId, taskId)).rejects.toThrow("Vendor-Policy");
    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
    expect(orc.tasks.get(taskId)?.status).toBe("ready");
  });

  it("leaves unbound agents on their original vessel", async () => {
    const mock = new Runtime("mock");
    orc.registerRuntime(mock);
    await orc.executeNextTask(companyId);
    expect(mock.calls).toHaveLength(1);
    expect(primary.calls).toHaveLength(0);
    expect(mock.calls[0].input.modelProfile).toBeUndefined();
  });
  it("dispatches the explicit primary model with atomically persisted vessel identities", async () => {
    configure();
    const origin = orc.listAgents(companyId).find((a) => a.id === agentId)!.vessel_id;
    const run = await orc.executeNextTask(companyId);
    expect(run?.task.status).toBe("review");
    expect(primary.calls[0]).toMatchObject({
      input: { model: "routing-example", modelProfile: "coding" },
      context: { agentId, permissionMode: "restricted" },
    });
    expect(
      db
        .prepare("SELECT routing_vessel_id,routing_origin_vessel_id,routing_profile_key FROM crew_runs WHERE id=?")
        .get(run!.runId),
    ).toEqual({
      routing_vessel_id: primaryTarget.vesselId,
      routing_origin_vessel_id: origin,
      routing_profile_key: "coding",
    });
    expect(orc.listAgents(companyId).find((a) => a.id === agentId)!.vessel_id).toBe(origin);
  });
  it("uses only an explicitly enabled healthy fallback and pins it across restart and unrelated revisions", async () => {
    configure();
    primary.online = false;
    await orc.executeNextTask(companyId);
    expect(fallback.calls).toHaveLength(1);
    const current = orc.routing.current(companyId);
    current.config.profiles[0].label = "Renamed unrelated profile";
    orc.routing.save(companyId, { expectedRevision: current.revision, config: current.config }, "ceo");
    orc = new CompanyOrchestrator(db);
    primary.online = true;
    orc.registerRuntime(primary);
    orc.registerRuntime(fallback);
    orc.requestRevision(companyId, taskId, "Add evidence");
    await orc.drainRunQueue(companyId);
    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(2);
    expect(fallback.calls[1].input.prompt).toContain("Add evidence");
  });
  it("retains disabled-fallback outages in the durable queue without spending attempts", async () => {
    configure({ allowFallback: false });
    primary.online = false;
    await expect(orc.executeNextTask(companyId)).rejects.toMatchObject({ code: "routing_unavailable" });
    expect(fallback.calls).toHaveLength(0);
    expect(
      db.prepare("SELECT status,attempts,run_id FROM crew_run_requests WHERE task_id=?").get(taskId),
    ).toMatchObject({ status: "queued", attempts: 0, run_id: null });
  });
  it("does not reuse a previously selected fallback after the owner disables it", async () => {
    configure();
    primary.online = false;
    await orc.executeNextTask(companyId);
    const current = orc.routing.current(companyId);
    current.config.profiles.find((p) => p.key === "coding")!.allowFallback = false;
    orc.routing.save(companyId, { expectedRevision: current.revision, config: current.config }, "ceo");
    orc.requestRevision(companyId, taskId, "Retry");
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ failed: 1 });
    expect(fallback.calls).toHaveLength(1);
    expect(primary.calls).toHaveLength(0);
  });
  it("never switches providers after work has started", async () => {
    configure();
    primary.failure = true;
    const run = await orc.executeNextTask(companyId);
    expect(run?.task.status).toBe("failed");
    expect(fallback.calls).toHaveLength(0);
  });
  it.each(["sensitivity", "capability", "workspace"] as const)(
    "hard stops on %s instead of taking a fallback",
    async (kind) => {
      configure(kind === "sensitivity" ? { allowedSensitivity: ["internal"] } : {});
      if (kind === "sensitivity") db.prepare("UPDATE crew_tasks SET sensitive=1 WHERE id=?").run(taskId);
      if (kind === "capability") primary.streaming = false;
      if (kind === "workspace") primary.workspaceRequired = true;
      await expect(orc.executeNextTask(companyId)).rejects.toThrow();
      expect(primary.calls).toHaveLength(0);
      expect(fallback.calls).toHaveLength(0);
    },
  );
  it.each(["mock", "claude", "codex"])("respects original and selected %s runtime budget", async (runtimeType) => {
    configure();
    if (runtimeType === "codex") primary.online = false;
    orc.budgets.setBudget({ companyId, scopeType: "runtime", scopeId: runtimeType, limitMicros: 100 });
    orc.budgets.recordCost({ companyId, runtimeType, costMicros: 100 });
    await expect(orc.executeNextTask(companyId)).rejects.toThrow("Budget hard stop");
    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
  });
  it.each(["mock", "claude", "anthropic"] as const)(
    "stops the stream at a hard stop for %s without double counting",
    async (scope) => {
      configure();
      orc.budgets.setBudget({
        companyId,
        scopeType: scope === "anthropic" ? "provider" : "runtime",
        scopeId: scope,
        limitMicros: 100,
      });
      primary.cost = 100;
      const run = await orc.executeNextTask(companyId);
      expect(run?.task.status).toBe("failed");
      expect(primary.afterUsage).toBe(false);
      expect(
        db.prepare("SELECT SUM(cost_micros) AS total FROM crew_cost_events WHERE company_id=?").get(companyId),
      ).toEqual({ total: 100 });
    },
  );
  it("honors original vessel capacity even with a different profile vessel", async () => {
    configure();
    const origin = orc.listAgents(companyId).find((a) => a.id === agentId)!.vessel_id!;
    const other = orc.listAgents(companyId).find((a) => a.id !== agentId && a.vessel_id === origin)!;
    const blocker = orc.tasks.create({ companyId, title: "Busy", assignedAgentId: other.id }).id;
    orc.runs.create({
      companyId,
      taskId: blocker,
      agentId: other.id,
      runtimeType: "mock",
      routingVesselId: origin,
      routingOriginVesselId: origin,
    });
    expect(await orc.executeNextTask(companyId)).toBeNull();
    expect(primary.calls).toHaveLength(0);
  });
  it("enforces vessel scope and rejects canonical vendor forgery at configuration time", () => {
    const foreign = seedCompany(db, "foreign");
    const vessel = orc.vessels.create({ companyId: foreign, key: "foreign", runtimeProvider: "claude" });
    expect(() => configure({ primary: { ...primaryTarget, vesselId: vessel.id } })).toThrow("Firma");
    expect(() =>
      configure({ primary: { ...primaryTarget, model: "qwen-code", vendorModel: "anthropic/routing-example" } }),
    ).toThrow();
  });
  it("stops a meeting at the canonical vendor budget between stream events", async () => {
    configure();
    orc.budgets.setBudget({ companyId, scopeType: "provider", scopeId: "anthropic", limitMicros: 100 });
    primary.cost = 100;
    const meeting = orc.meetings.create({
      companyId,
      topic: "Planning",
      moderatorAgentId: agentId,
      participantAgentIds: [orc.listAgents(companyId).find((a) => a.id !== agentId)!.id],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);
    const turn = await orc.runMeetingTurn(companyId, meeting.id, { agentId });
    expect(turn?.turn.contribution).toContain("Budget hard stop");
    expect(primary.afterUsage).toBe(false);
    expect(fallback.calls).toHaveLength(0);
  });
  it("records an incomplete meeting stream as an error, not a successful contribution", async () => {
    configure();
    primary.incomplete = true;
    const meeting = orc.meetings.create({
      companyId,
      topic: "Planning",
      moderatorAgentId: agentId,
      participantAgentIds: [orc.listAgents(companyId).find((a) => a.id !== agentId)!.id],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);
    const result = await orc.runMeetingTurn(companyId, meeting.id, { agentId });
    expect(result?.turn.contribution).toContain("ohne bestätigten Abschluss");
    expect(fallback.calls).toHaveLength(0);
  });
  it("routes meeting turns through the same model and restrictive permissions", async () => {
    configure();
    primary.online = false;
    const meeting = orc.meetings.create({
      companyId,
      topic: "Planning",
      moderatorAgentId: agentId,
      participantAgentIds: [orc.listAgents(companyId).find((a) => a.id !== agentId)!.id],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);
    await orc.runMeetingTurn(companyId, meeting.id, { agentId });
    expect(fallback.calls[0]).toMatchObject({
      input: { model: "routing-example", modelProfile: "coding" },
      context: { sensitive: true, permissionMode: "restricted" },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crew_routing_meeting_leases").get()).toEqual({ n: 0 });
  });
});
