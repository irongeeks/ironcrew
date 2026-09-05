import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";

class CaptureRuntime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  constructor() {
    super("mock");
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "run.started");
    yield stubEvent(context, "message.completed", { text: "Testbericht mit Quellen fertig." });
    yield stubEvent(context, "run.completed");
  }
}
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let runtime: CaptureRuntime;
let companyId: string;
let agentId: string;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  runtime = new CaptureRuntime();
  orc.registerRuntime(runtime);
  companyId = orc.seedCompany({
    name: "Coaching context",
    slug: "coaching-context",
    crew: loadCrewConfig(undefined, path.join(configDir(), "private", "__missing__.local.yaml")),
    departments: loadDepartmentConfig(),
  });
  agentId = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!.id;
});
afterEach(() => db.close());
const actor = { actorType: "owner" as const, actorId: "ceo" };
const instruction = "Jeden Prüfbericht mit einer konkreten Quellenliste abschließen.";
function propose() {
  return orc.coaching.create(
    companyId,
    {
      agentId,
      title: "Quellenorientierte Berichte",
      guidance: instruction,
      skills: [],
      cases: [{ label: "Konkrete Quellenliste", kind: "guidance_contains", expected: "Quellenliste" }],
    },
    actor,
  );
}
function task() {
  return orc.tasks.create({
    companyId,
    title: "Dokumentation prüfen",
    description: "Prüfe die technische Dokumentation.",
    status: "ready",
    assignedAgentId: agentId,
  });
}
describe("approved coaching in real orchestrator context", () => {
  it("does not inject drafts or evaluated proposals; only an owner-approved version affects later runs", async () => {
    const draft = propose();
    orc.coaching.evaluate(companyId, draft.id, actor);
    task();
    const before = await orc.executeNextTask(companyId);
    expect(before?.task.status).toBe("review");
    expect(runtime.calls[0].input.prompt).not.toContain(instruction);
    const policyBefore = orc.listAgents(companyId).find((agent) => agent.id === agentId)!.policy_json;
    orc.coaching.review(
      companyId,
      draft.id,
      { decision: "approve", reason: "Prüfbare Quellenregel fachlich bestätigt." },
      actor,
    );
    const restarted = new CompanyOrchestrator(db);
    const nextRuntime = new CaptureRuntime();
    restarted.registerRuntime(nextRuntime);
    restarted.tasks.create({
      companyId,
      title: "Zweiter Prüfbericht",
      description: "Prüfe erneut.",
      status: "ready",
      assignedAgentId: agentId,
    });
    const after = await restarted.executeNextTask(companyId);
    expect(after?.task.status).toBe("review");
    expect(nextRuntime.calls[0].input.prompt).toContain(instruction);
    expect(nextRuntime.calls[0].input.prompt).toContain("Version 1");
    expect(nextRuntime.calls[0].input.prompt).toContain("untergeordnet zu Policy");
    expect(restarted.listAgents(companyId).find((agent) => agent.id === agentId)!.policy_json).toBe(policyBefore);
    expect(
      db
        .prepare("SELECT details_json FROM crew_audit_events WHERE action='coaching.context_used' AND entity_id=?")
        .get(after!.runId),
    ).toMatchObject({ details_json: expect.stringContaining('"version":1') });
  });
  it("keeps lessons and rejected proposals out of execution instructions", async () => {
    const draft = propose();
    orc.coaching.review(companyId, draft.id, { decision: "reject", reason: "Bitte genauer begründen." }, actor);
    orc.coaching.note(companyId, { agentId, kind: "lesson", title: "Neue Idee", body: instruction }, actor);
    task();
    await orc.executeNextTask(companyId);
    expect(runtime.calls[0].input.prompt).not.toContain(instruction);
    expect(orc.coaching.current(companyId, agentId)).toBeNull();
  });
});
