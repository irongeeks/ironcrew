import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { UserStore } from "../auth/user-store.ts";
import { RunnerServer } from "../runner/runner-server.ts";
import { RunnerRuntime } from "../runner/runner-client.ts";
import { socketPair } from "../runner/__fixtures__/socket-pair.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";

class ControlledRuntime extends StubRuntime {
  contexts: RunContext[] = [];
  hold = false;
  cancelled = vi.fn(async (_id: string) => {});
  constructor() {
    super("codex");
  }
  override async *startRun(_input: RunInput, ctx: RunContext) {
    this.contexts.push(ctx);
    yield stubEvent(ctx, "run.started", { permissionMode: ctx.permissionMode });
    if (this.hold)
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        else ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    if (ctx.signal?.aborted) {
      yield stubEvent(ctx, "run.cancelled", { reason: "Sandbox stopped" }, 1);
      return;
    }
    yield stubEvent(ctx, "message.completed", { text: "Test finished" }, 1);
    yield stubEvent(ctx, "run.completed", {}, 2);
  }
  override cancelRun(id: string) {
    return this.cancelled(id);
  }
}
let db: DatabaseSync;
let dir: string;
let orc: CompanyOrchestrator;
let companyId: string;
let ownerId: string;
let taskId: string;
let runtime: ControlledRuntime;
let server: RunnerServer;
beforeEach(async () => {
  db = createTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-sandbox-"));
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Sandbox", slug: "sandbox" });
  ownerId = (
    await new UserStore(db).create({
      email: "sandbox-owner@example.invalid",
      role: "owner",
      password: "sandbox-test-password",
    })
  ).id;
  runtime = new ControlledRuntime();
  server = new RunnerServer({ runtimes: [runtime], token: "sandbox-token", workspaceRoot: dir });
  const client = new RunnerRuntime({
    runtimeType: "codex",
    token: "sandbox-token",
    idleTimeoutMs: 120000,
    connect: async () => {
      const pair = socketPair();
      server.handleConnection(pair.server);
      return pair.client;
    },
  });
  orc.registerRuntime(client);
  const agent = orc.getAgent(companyId, "cto")!;
  orc.setAgentRuntimeProvider(companyId, agent.id, "codex", { actorId: ownerId });
  const project = orc.projects.create({ companyId, title: "Isolated project", workspacePath: dir });
  taskId = orc.tasks.create({
    companyId,
    projectId: project.id,
    assignedAgentId: agent.id,
    title: "Sandbox job",
    status: "ready",
  }).id;
});
afterEach(() => {
  server.closeConnections();
  db.close();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});
function approve() {
  const approval = orc.sandboxAccess.request(
    companyId,
    { taskId, provider: "codex", durationMs: 60000, reason: "Isolierten Test einmalig freigeben" },
    ownerId,
  );
  orc.reviewApproval(companyId, approval.id, "approved", "Geprüft", { actorId: ownerId });
  return orc.sandboxAccess.settleApproval(companyId, approval.id)!;
}
describe("sandbox approval through real company and native run path", () => {
  it("keeps unapproved runs restricted and forwards consumed owner approval to exactly one later run", async () => {
    await orc.executeNextTask(companyId);
    expect(runtime.contexts[0].permissionMode).toBe("restricted");
    const grant = approve();
    const result = await orc.executeNextTask(companyId);
    expect(result?.task.status).toBe("review");
    expect(runtime.contexts[1]).toMatchObject({
      permissionMode: "elevated",
      sandboxGrantId: grant.id,
      sandboxExpiresAt: grant.expires_at,
    });
    expect(orc.runs.get(result!.runId)).toMatchObject({ permission_mode: "elevated", sandbox_grant_id: grant.id });
    orc.requestRevision(companyId, taskId, "Weitere Prüfung");
    await orc.executeNextTask(companyId);
    expect(runtime.contexts[2].permissionMode).toBe("restricted");
  });
  it("cancels the actual native runtime on owner revocation", async () => {
    const grant = approve();
    runtime.hold = true;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = orc.executeNextTask(companyId, {
      onEvent: (event) => {
        if (event.type === "run.started") started();
      },
    });
    await start;
    const revoked = orc.sandboxAccess.revoke(companyId, grant.id, ownerId, "Stop")!;
    await orc.abortRun(companyId, revoked.consumed_run_id!, "Sandbox widerrufen");
    const result = await running;
    expect(runtime.contexts[0].signal?.aborted).toBe(true);
    expect(result?.task.status).toBe("failed");
    expect(orc.sandboxAccess.grants.get(grant.id)?.revoked_at).not.toBeNull();
  });
  it("stops on expiry even when the control plane does not issue an explicit cancel frame", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    approve();
    runtime.hold = true;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = orc.executeNextTask(companyId, {
      onEvent: (event) => {
        if (event.type === "run.started") started();
      },
    });
    await start;
    await vi.advanceTimersByTimeAsync(60000);
    const result = await running;
    expect(runtime.contexts[0].signal?.aborted).toBe(true);
    expect(result?.task.status).toBe("failed");
  });
});
