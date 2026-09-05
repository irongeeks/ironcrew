import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunInput, RunContext } from "../runtime/run-events.ts";
import { verifyAuditChain } from "../domain/audit.ts";

class CaptureRuntime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "run.started");
    yield stubEvent(context, "message.completed", { text: "Geprüftes Ergebnis." }, 1);
    yield stubEvent(context, "run.completed", {}, 2);
  }
}
let db: DatabaseSync, orc: CompanyOrchestrator, companyId: string, agentId: string, runtime: CaptureRuntime;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({
    name: "Policy",
    slug: "policy",
    crew: loadCrewConfig(undefined, path.join(configDir(), "private", "__missing__.yaml")),
    departments: loadDepartmentConfig(),
  });
  agentId = orc.getAgent(companyId, "cto")!.id;
  runtime = new CaptureRuntime("claude");
  orc.registerRuntime(runtime);
  db.prepare("UPDATE crew_vessels SET runtime_provider='claude',model='sonnet' WHERE company_id=?").run(companyId);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function restrict(allowedFamilies: string[], allowedProviders?: string[]) {
  const current = orc.companyPolicies.snapshot(companyId);
  return orc.companyPolicies.save(
    companyId,
    {
      baseRevision: current.revision,
      baselineFingerprint: current.baselineFingerprint,
      reason: "Modellbetrieb auf freigegebene Anbieter begrenzen.",
      restrictions: { allowedFamilies, allowedProviders: allowedProviders ?? current.restrictions.allowedProviders },
    },
    "ceo",
  );
}
function task() {
  return orc.tasks.create({ companyId, title: "Dokumentation", status: "ready", assignedAgentId: agentId });
}
describe("company policy is an execution boundary", () => {
  it("blocks an unbound CLI alias and persists failure without calling its runtime", async () => {
    restrict(["openai/*"]);
    const result = await orc.executeTaskById(companyId, task().id);
    expect(result?.task.status).toBe("failed");
    expect(result?.events.some((e) => e.type === "run.failed" && String(e.payload.message).includes("allow"))).toBe(
      true,
    );
    expect(runtime.calls).toHaveLength(0);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
  it("passes canonical CLI aliases and transmits only the effective restrictions", async () => {
    const saved = restrict(["anthropic/*"]);
    const result = await orc.executeTaskById(companyId, task().id);
    expect(result?.task.status).toBe("review");
    expect(runtime.calls[0].input.model).toBe("sonnet");
    expect(runtime.calls[0].context.vendorRestrictions).toEqual(saved.restrictions);
  });
  it("rechecks after async workspace discovery before dispatch", async () => {
    vi.spyOn(runtime, "capabilities").mockImplementation(async () => {
      restrict(["openai/*"]);
      return { ...(await new CaptureRuntime("mock").capabilities()), workspaceRequired: false };
    });
    const result = await orc.executeTaskById(companyId, task().id);
    expect(result?.task.status).toBe("failed");
    expect(runtime.calls).toHaveLength(0);
  });
  it("survives orchestrator restart and blocks EA project planning", async () => {
    restrict(["openai/*"]);
    orc = new CompanyOrchestrator(db);
    orc.registerRuntime(runtime);
    const planned = orc.handleCeoMessage(
      companyId,
      "Wir starten ein Projekt für eine lokale Demo und eine dokumentierte Prüfung.",
    );
    expect(planned.triage.category).toBe("project");
    const result = await orc.executeTaskById(companyId, planned.task!.id);
    expect(result?.task.status).toBe("failed");
    expect(runtime.calls).toHaveLength(0);
  });
  it("blocks unbound meetings and records an explicit error contribution", async () => {
    restrict(["openai/*"]);
    const meeting = orc.meetings.create({
      companyId,
      topic: "Review",
      moderatorAgentId: agentId,
      participantAgentIds: [orc.getAgent(companyId, "coo")!.id],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);
    const result = await orc.runMeetingTurn(companyId, meeting.id, { agentId });
    expect(result?.turn.contribution).toContain("Fehler");
    expect(runtime.calls).toHaveLength(0);
  });
  it("uses an unbound meeting's configured model and effective policy", async () => {
    const saved = restrict(["anthropic/*"]);
    const meeting = orc.meetings.create({
      companyId,
      topic: "Review",
      moderatorAgentId: agentId,
      participantAgentIds: [orc.getAgent(companyId, "coo")!.id],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);
    await orc.runMeetingTurn(companyId, meeting.id, { agentId });
    expect(runtime.calls[0].input.model).toBe("sonnet");
    expect(runtime.calls[0].context.vendorRestrictions).toEqual(saved.restrictions);
  });
});
