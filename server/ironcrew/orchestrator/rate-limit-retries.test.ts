import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CompanyOrchestrator } from "./company.ts";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Retry test", slug: "retry-test", crew, departments: loadDepartmentConfig() });
  orc.registerRuntime(new MockRuntime({ scenario: "rate_limit" }));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function enqueue(maxRetries: number) {
  db.prepare("UPDATE crew_vessels SET max_retries = ? WHERE company_id = ?").run(maxRetries, companyId);
  const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
  return { task, request: orc.runRequests.liveForTask(task.id)! };
}

describe("bounded provider rate-limit retries", () => {
  it.each([0, 1, 3, 8])("stops after max_retries=%i without accumulating untouched runs", async (maxRetries) => {
    const { task, request } = enqueue(maxRetries);
    const onEvent = vi.fn();
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const startedAt = Date.now();
      const result = await orc.drainRunQueue(companyId, { onEvent });
      const persisted = orc.runRequests.get(request.id)!;
      expect(persisted.attempts).toBe(attempt);
      expect(orc.runs.listForTask(task.id)).toHaveLength(1);
      if (attempt <= maxRetries) {
        expect(result.deferred).toBe(1);
        expect(persisted.status).toBe("queued");
        expect(persisted.not_before - startedAt).toBe(Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000));
        vi.setSystemTime(persisted.not_before - 1);
        expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
        vi.setSystemTime(persisted.not_before);
      } else {
        expect(result.failed).toBe(1);
        expect(persisted.status).toBe("dead");
        expect(persisted.last_error).toContain("ausgeschöpft");
        expect(orc.tasks.get(task.id)).toMatchObject({ status: "failed", result_summary: persisted.last_error });
        expect(orc.runs.get(persisted.run_id!)).toMatchObject({
          status: "failed",
          error_message: persisted.last_error,
        });
        expect(onEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: "run.failed",
            payload: expect.objectContaining({ reason: "rate_limit_retries_exhausted", attempts: attempt }),
          }),
        );
      }
    }
    const run = orc.runs.listForTask(task.id)[0];
    const events = orc.runs.listEvents(run.id);
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(maxRetries + 1);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
    expect(orc.runs.listEvents(run.id)).toHaveLength(events.length);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("returns and broadcasts the terminal failure from a manual start with no retries", async () => {
    enqueue(0);
    const onEvent = vi.fn();
    const executed = await orc.executeNextTask(companyId, { onEvent });
    expect(executed?.task.status).toBe("failed");
    expect(executed?.events.at(-1)?.type).toBe("run.failed");
    expect(onEvent).toHaveBeenLastCalledWith(executed?.events.at(-1));
  });

  it.each(["resetAt", "retryAfterMs"])("respects %s beyond the exponential backoff cap", async (field) => {
    const runtime = new MockRuntime();
    const delay = 30 * 60_000;
    vi.spyOn(runtime, "startRun").mockImplementation(async function* (_input, context) {
      yield stubEvent(context, "run.started");
      yield stubEvent(context, "rate_limit.detected", { [field]: field === "resetAt" ? Date.now() + delay : delay });
      yield stubEvent(context, "run.waiting", { reason: "rate_limited" });
    });
    orc.registerRuntime(runtime);
    const { request } = enqueue(1);
    await orc.drainRunQueue(companyId);
    expect(orc.runRequests.get(request.id)).toMatchObject({ attempts: 1, not_before: Date.now() + delay });
    vi.setSystemTime(Date.now() + delay - 1);
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
  });

  it.each(["model", "workspace", "partial output", "session"])(
    "preserves separate history after %s changes",
    async (change) => {
      const { task, request } = enqueue(1);
      await orc.drainRunQueue(companyId);
      const first = orc.runs.listForTask(task.id)[0];
      if (change === "model")
        db.prepare("UPDATE crew_vessels SET model = 'another-model' WHERE company_id = ?").run(companyId);
      if (change === "workspace") orc.runs.setWorkspace(first.id, "/previous-workspace");
      if (change === "partial output" || change === "session") {
        orc.runs.appendEvent({
          companyId,
          taskId: task.id,
          runId: first.id,
          type: change === "session" ? "run.waiting" : "message.delta",
          payload: change === "session" ? { sessionRef: "previous-session" } : { text: "Partial result" },
        });
        orc.runs.setStatus(first.id, "rate_limited");
      }
      vi.setSystemTime(orc.runRequests.get(request.id)!.not_before);
      orc.registerRuntime(new MockRuntime());
      expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
      expect(orc.runs.listForTask(task.id)).toHaveLength(2);
      expect(orc.runs.get(first.id)?.status).toBe("rate_limited");
      expect(orc.runRequests.get(request.id)?.attempts).toBe(2);
    },
  );
});
