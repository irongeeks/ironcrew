import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";

// Integration regressions: no external runtimes, network, or accounts.
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Review", slug: "review", crew, departments: loadDepartmentConfig() });
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("review: orchestrator integration regressions", () => {
  it("retries a failed runtime after backoff without a human changing task status", async () => {
    orc.registerRuntime(new MockRuntime({ scenario: "failure" }));
    db.prepare("UPDATE crew_vessels SET max_retries = 1 WHERE company_id = ?").run(companyId);
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    const request = orc.runRequests.liveForTask(task.id)!;
    expect((await orc.drainRunQueue(companyId)).failed).toBe(1);
    expect(orc.runRequests.get(request.id)!.status).toBe("queued");
    // Only advance the backoff deadline; do not artificially repair task status.
    db.prepare("UPDATE crew_run_requests SET not_before = 0 WHERE id = ?").run(request.id);
    orc.registerRuntime(new MockRuntime({ responseText: "Retry succeeded." }));
    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(new MockRuntime({ responseText: "Retry succeeded." }));
    const retried = await restarted.drainRunQueue(companyId);
    expect(retried.completed).toBe(1);
    expect(orc.tasks.get(task.id)!.status).toBe("review");
  });

  it("passes the saved project workspace to the runtime during scheduled execution", async () => {
    orc.registerRuntime(new MockRuntime());
    const workspacePath = "/var/lib/ironcrew/workspaces/customer-a";
    const project = orc.projects.create({ companyId, title: "Customer A", workspacePath });
    const agent = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!;
    const task = orc.tasks.create({
      companyId,
      projectId: project.id,
      title: "Review project",
      description: "Read files",
      status: "ready",
      assignedAgentId: agent.id,
    });
    orc.enqueueRun(companyId, task.id);
    await orc.drainRunQueue(companyId);
    const run = orc.runs.listForTask(task.id)[0];
    const started = orc.runs.listEvents(run.id).find((e) => e.type === "run.started")!;
    expect(started.payload.workspace).toBe(workspacePath);
  });

  it("preserves runnable intent after a temporary provider rate limit", async () => {
    orc.registerRuntime(new MockRuntime({ scenario: "rate_limit" }));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    const request = orc.runRequests.liveForTask(task.id)!;
    await orc.drainRunQueue(companyId);
    expect(orc.tasks.get(task.id)!.status).toBe("waiting");
    expect(orc.runRequests.get(request.id)!.status).toBe("queued");
  });
  it("honours the persisted cooldown across restart without spending retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const resetAt = Date.now() + 120_000;
    orc.registerRuntime(new MockRuntime({ scenario: "rate_limit", rateLimitResetAt: resetAt }));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    const request = orc.runRequests.liveForTask(task.id)!;
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 0, deferred: 1 });
    expect(orc.runRequests.get(request.id)).toMatchObject({ status: "queued", attempts: 0, not_before: resetAt });
    expect(orc.agentStatus(companyId, task.assigned_agent_id!)).toBe("rate_limited");

    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(new MockRuntime({ responseText: "Fortgesetzt." }));
    vi.setSystemTime(resetAt - 1);
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
    expect(restarted.runs.listForTask(task.id)).toHaveLength(1);
    vi.setSystemTime(resetAt);
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
    expect(restarted.tasks.get(task.id)!.status).toBe("review");
    expect(restarted.runRequests.get(request.id)).toMatchObject({ status: "done", attempts: 1 });
    expect(restarted.agentStatus(companyId, task.assigned_agent_id!)).toBe("idle");
  });

  it("does not turn approval waiting into an automatic provider retry", async () => {
    orc.registerRuntime(new MockRuntime({ scenario: "approval_required" }));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    await orc.drainRunQueue(companyId);
    orc.registerRuntime(new MockRuntime());
    orc.enqueueRun(companyId, task.id);
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 0, deferred: 1 });
    expect(orc.tasks.get(task.id)!.status).toBe("waiting");
    expect(orc.runs.listForTask(task.id)).toHaveLength(1);
  });

  it("does not revive a cancelled task after a rate limit", async () => {
    orc.registerRuntime(new MockRuntime({ scenario: "rate_limit" }));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    await orc.drainRunQueue(companyId);
    const request = orc.runRequests.liveForTask(task.id)!;
    orc.tasks.transition(task.id, "cancelled", { reason: "CEO stop" });
    db.prepare("UPDATE crew_run_requests SET not_before = 0 WHERE id = ?").run(request.id);
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 0 });
    expect(orc.runRequests.get(request.id)!.status).toBe("cancelled");
    expect(orc.runs.listForTask(task.id)).toHaveLength(1);
  });

  it("rejects a missing workspace for a filesystem runtime before invoking it", async () => {
    const runtime = new MockRuntime();
    vi.spyOn(runtime, "capabilities").mockResolvedValue({ ...(await runtime.capabilities()), workspaceRequired: true });
    const start = vi.spyOn(runtime, "startRun");
    orc.registerRuntime(runtime);
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ failed: 1 });
    expect(start).not.toHaveBeenCalled();
    expect(orc.runs.listForTask(task.id)[0].error_message).toContain("Kein Projekt-Workspace");
  });
  it("defers other tasks sharing the rate-limited runtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const runtime = new MockRuntime({ scenario: "rate_limit" });
    const start = vi.spyOn(runtime, "startRun");
    orc.registerRuntime(runtime);
    orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren A.");
    const second = orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren B.").task!;
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 0, deferred: 2 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(orc.runs.listForTask(second.id)).toHaveLength(0);
    expect(orc.runRequests.liveForTask(second.id)!.attempts).toBe(0);
  });
  it("resumes a rate-limited manual start through the scheduler after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const resetAt = Date.now() + 60_000;
    orc.registerRuntime(new MockRuntime({ scenario: "rate_limit", rateLimitResetAt: resetAt }));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren A.").task!;
    expect((await orc.executeNextTask(companyId))?.task.status).toBe("waiting");
    const request = orc.runRequests.liveForTask(task.id)!;
    expect(request).toMatchObject({ status: "queued", attempts: 0, not_before: resetAt });
    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(new MockRuntime());
    vi.setSystemTime(resetAt);
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
    expect(restarted.tasks.get(task.id)?.status).toBe("review");
  });
  it("renews live leases and fences a late worker after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    let release!: () => void;
    let signalStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const runtime = new MockRuntime();
    vi.spyOn(runtime, "startRun").mockImplementation(async function* (_input, context) {
      yield stubEvent(context, "run.started");
      signalStarted();
      await blocked;
      yield stubEvent(context, "run.completed", { summary: "stale result" });
    });
    orc.registerRuntime(runtime);
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere Verfahren A.").task!;
    const draining = orc.drainRunQueue(companyId, { limit: 1 });
    await started;
    const request = orc.runRequests.liveForTask(task.id)!;
    const originalTask = orc.tasks.get(task.id)!;
    const oldRunId = originalTask.execution_run_id!;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(orc.runRequests.get(request.id)!.lease_expires_at).toBeGreaterThan(request.lease_expires_at!);
    expect(orc.tasks.get(task.id)!.lock_expires_at).toBeGreaterThan(originalTask.lock_expires_at!);

    orc.tasks.recoverOrphaned(task.id, oldRunId);
    const recovered = orc.tasks.get(task.id)!;
    const successorRun = orc.runs.create({
      companyId,
      taskId: task.id,
      agentId: task.assigned_agent_id,
      runtimeType: "mock",
    });
    orc.tasks.claim({
      taskId: task.id,
      runId: successorRun.id,
      agentId: task.assigned_agent_id!,
      expectedVersion: recovered.status_version,
    });
    orc.tasks.transition(task.id, "running", { reason: "successor started" });
    orc.agentLocks.release(task.assigned_agent_id!, oldRunId);
    orc.agentLocks.acquire(task.assigned_agent_id!, successorRun.id);
    db.prepare("UPDATE crew_run_requests SET lease_expires_at = 0 WHERE id = ?").run(request.id);
    const successorRequest = orc.runRequests.claimNext(companyId, "successor")!;
    release();
    await draining;
    expect(orc.tasks.get(task.id)).toMatchObject({ status: "running", execution_run_id: successorRun.id });
    expect(orc.agentLocks.get(task.assigned_agent_id!)!.runId).toBe(successorRun.id);
    expect(orc.runRequests.get(request.id)).toEqual(successorRequest);
    expect(orc.runs.listEvents(oldRunId).some((event) => event.type === "run.completed")).toBe(false);
  });
});
