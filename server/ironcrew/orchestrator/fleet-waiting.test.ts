import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { FleetHub } from "../runner/fleet/hub.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { verifyAuditChain } from "../domain/audit.ts";

it("keeps unavailable fleet work queued without attempts or provider limits and executes it after database reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-queue-restart-"));
  const file = path.join(directory, "company.sqlite");
  let db = createTestDb(file);
  let hub: FleetHub | undefined;
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const orc = new CompanyOrchestrator(db);
    const companyId = orc.seedCompany({
      name: "Fleet Queue",
      slug: "fleet-queue",
      crew: loadCrewConfig(undefined, path.join(configDir(), "private", "__missing__.yaml")),
      departments: loadDepartmentConfig(),
    });
    hub = new FleetHub({ db, companyId });
    orc.registerRuntime(hub.runtime("mock"));
    const project = orc.projects.create({ companyId, title: "Fleet Project", workspacePath: directory });
    const agent = orc.listAgents(companyId).find((item) => !item.is_executive_assistant)!;
    const task = orc.tasks.create({
      companyId,
      projectId: project.id,
      title: "Prüfbericht erstellen",
      status: "ready",
      assignedAgentId: agent.id,
    });
    const { request } = orc.enqueueRun(companyId, task.id)!;

    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 1, deferred: 1, completed: 0, failed: 0 });
    const waiting = orc.runRequests.get(request.id)!;
    expect(waiting).toMatchObject({ status: "queued", attempts: 0 });
    expect(orc.tasks.get(task.id)?.status).toBe("waiting");
    const firstRun = orc.runs.listForTask(task.id)[0];
    expect(firstRun.status).toBe("waiting");
    const events = orc.runs.listEvents(firstRun.id);
    expect(events.some((event) => event.type === "rate_limit.detected")).toBe(false);
    const wait = events.find((event) => event.type === "run.waiting")!;
    expect(wait.payload.reason).toBe("runner_unavailable");
    expect(typeof wait.payload.retryAt).toBe("number");
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
    expect(orc.runRequests.get(request.id)?.attempts).toBe(0);

    hub.close();
    hub = undefined;
    db.close();
    db = new DatabaseSync(file);
    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(new MockRuntime({ responseText: "Runner wieder frei; Bericht erstellt." }));
    now = Number(wait.payload.retryAt) - 1;
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
    now = Number(wait.payload.retryAt) + 1;
    expect(await restarted.drainRunQueue(companyId)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(restarted.tasks.get(task.id)?.status).toBe("review");
    expect(restarted.runRequests.get(request.id)).toMatchObject({ status: "done", attempts: 1 });
    expect(restarted.runs.listForTask(task.id)).toHaveLength(2);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  } finally {
    hub?.close();
    db.close();
    clock.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  // File-backed migrations, two dispatches, database reopen and audit verification
  // also run under coverage beside the full backend suite on shared CI workers.
}, 15_000);
