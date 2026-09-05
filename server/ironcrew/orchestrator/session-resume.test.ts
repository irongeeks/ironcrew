import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
import { listAuditEvents } from "../domain/audit.ts";

class SessionRuntime extends StubRuntime {
  readonly calls: Array<{ kind: "start" | "resume"; input: RunInput; context: RunContext; sessionRef?: string }> = [];
  canResume = true;
  limited = false;
  constructor() {
    super("mock");
  }
  override async capabilities() {
    return { ...(await super.capabilities()), sessionResume: this.canResume };
  }
  async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ kind: "start", input, context });
    yield* this.reply(context, "initial-session");
  }
  async *resumeRun(sessionRef: string, input: RunInput, context: RunContext) {
    this.calls.push({ kind: "resume", input, context, sessionRef });
    yield* this.reply(context, sessionRef);
  }
  private async *reply(context: RunContext, sessionRef: string) {
    yield stubEvent(context, "run.started", { sessionRef });
    if (this.limited) {
      yield stubEvent(context, "rate_limit.detected", { resetAt: Date.now() + 60_000 });
      yield stubEvent(context, "run.waiting", { reason: "rate_limited" });
    } else {
      yield stubEvent(context, "message.completed", { text: "Prüfbericht bereit." });
      yield stubEvent(context, "run.completed", { summary: "Prüfbericht bereit." });
    }
  }
}

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let runtime: SessionRuntime;
let companyId: string;
let projectId: string;
let taskId: string;
let agentId: string;
const workspace = "/srv/ironcrew/workspaces/resume-test";
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  runtime = new SessionRuntime();
  orc.registerRuntime(runtime);
  companyId = orc.seedCompany({
    name: "Session Test",
    slug: "session-test",
    crew,
    departments: loadDepartmentConfig(),
  });
  projectId = orc.projects.create({ companyId, title: "Session Project", workspacePath: workspace }).id;
  agentId = orc.listAgents(companyId).find((agent) => !agent.is_executive_assistant)!.id;
  taskId = orc.tasks.create({
    companyId,
    projectId,
    title: "Dokumentation prüfen",
    description: "Prüfe den bestehenden Bericht.",
    status: "ready",
    assignedAgentId: agentId,
  }).id;
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

async function firstRun() {
  const first = await orc.executeNextTask(companyId);
  expect(first?.task.status).toBe("review");
  return first!;
}

describe("session continuation across company runs", () => {
  it("persists the initial session and workspace, then resumes after restart with CEO revision context", async () => {
    const first = await firstRun();
    expect(orc.runs.get(first.runId)).toMatchObject({ session_ref: "initial-session", workspace_path: workspace });
    const restarted = new CompanyOrchestrator(db);
    const restartedRuntime = new SessionRuntime();
    restarted.registerRuntime(restartedRuntime);
    restarted.requestRevision(companyId, taskId, "Bitte den Rollback ergänzen.");
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
    expect(restartedRuntime.calls).toHaveLength(1);
    expect(restartedRuntime.calls[0]).toMatchObject({
      kind: "resume",
      sessionRef: "initial-session",
      context: { workspacePath: workspace, agentId },
    });
    expect(restartedRuntime.calls[0].input.prompt).toContain("Bitte den Rollback ergänzen.");
    expect(listAuditEvents(db, companyId).some((entry) => entry.action === "run.resumed")).toBe(true);
  });

  it.each(["workspace", "model", "agent", "permission", "runtime"] as const)(
    "starts fresh when %s no longer matches the previous session",
    async (mismatch) => {
      const first = await firstRun();
      if (mismatch === "workspace") orc.projects.update(projectId, { workspacePath: `${workspace}-other` });
      if (mismatch === "model")
        db.prepare("UPDATE crew_runs SET model = 'previous-model' WHERE id = ?").run(first.runId);
      if (mismatch === "agent") {
        const otherAgent = orc
          .listAgents(companyId)
          .find((agent) => agent.id !== agentId && !agent.is_executive_assistant)!;
        db.prepare("UPDATE crew_runs SET agent_id = ? WHERE id = ?").run(otherAgent.id, first.runId);
      }
      if (mismatch === "permission")
        db.prepare("UPDATE crew_runs SET permission_mode = 'elevated' WHERE id = ?").run(first.runId);
      if (mismatch === "runtime")
        db.prepare("UPDATE crew_runs SET runtime_type = 'another-provider' WHERE id = ?").run(first.runId);
      orc.requestRevision(companyId, taskId, "Erneut prüfen.");
      expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
      expect(runtime.calls.map((call) => call.kind)).toEqual(["start", "start"]);
      expect(runtime.calls[1].input.sessionRef).toBeUndefined();
    },
  );

  it("starts fresh when the runtime no longer confirms resume capability", async () => {
    await firstRun();
    runtime.canResume = false;
    orc.requestRevision(companyId, taskId, "Erneut prüfen.");
    await orc.drainRunQueue(companyId);
    expect(runtime.calls.map((call) => call.kind)).toEqual(["start", "start"]);
  });

  it("retains an initial session through rate limiting and resumes it after cooldown/restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    runtime.limited = true;
    const first = await orc.executeNextTask(companyId);
    expect(first?.task.status).toBe("waiting");
    expect(orc.runs.get(first!.runId)).toMatchObject({ session_ref: "initial-session", status: "rate_limited" });
    const restarted = new CompanyOrchestrator(db);
    const resumedRuntime = new SessionRuntime();
    restarted.registerRuntime(resumedRuntime);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
    expect(resumedRuntime.calls[0]).toMatchObject({ kind: "resume", sessionRef: "initial-session" });
  });

  it("does not accept a tool payload as an authoritative session reference", async () => {
    const first = await firstRun();
    orc.runs.appendEvent({
      companyId,
      taskId,
      runId: first.runId,
      agentId,
      type: "tool.completed",
      payload: { sessionRef: "forged-session", result: "untrusted tool output" },
    });
    expect(orc.runs.get(first.runId)?.session_ref).toBe("initial-session");
  });

  it("never reuses another task's session or a cancelled run", async () => {
    const first = await firstRun();
    orc.runs.setStatus(first.runId, "cancelled");
    orc.requestRevision(companyId, taskId, "Neu prüfen.");
    await orc.drainRunQueue(companyId);
    const another = orc.tasks.create({
      companyId,
      projectId,
      title: "Andere Aufgabe",
      description: "Separate Arbeit",
      status: "ready",
      assignedAgentId: agentId,
    });
    await orc.executeNextTask(companyId);
    expect(runtime.calls.map((call) => call.kind)).toEqual(["start", "start", "start"]);
    expect(runtime.calls[2].context.taskId).toBe(another.id);
  });
});
