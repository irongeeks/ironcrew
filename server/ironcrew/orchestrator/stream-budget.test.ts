import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
import { CompanyOrchestrator } from "./company.ts";

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
let db: DatabaseSync;
let orchestrator: CompanyOrchestrator;
let companyId: string;

class MultiRoundRuntime extends StubRuntime {
  nextRoundCalls = 0;
  abortedOnClose = false;
  constructor(private readonly costMicros: number) {
    super("mock");
  }
  async *startRun(_input: RunInput, context: RunContext) {
    try {
      yield stubEvent(context, "run.started");
      yield stubEvent(
        context,
        "usage.updated",
        { inputTokens: 10_000, outputTokens: 2_000, costMicros: this.costMicros },
        1,
      );
      // This represents the next tool execution or paid model request. The
      // orchestrator must close the iterator before it can be reached.
      this.nextRoundCalls++;
      yield stubEvent(context, "message.completed", { text: "Second round completed" }, 2);
      yield stubEvent(context, "run.completed", {}, 3);
    } finally {
      this.abortedOnClose = context.signal?.aborted === true;
    }
  }
}

beforeEach(() => {
  db = createTestDb();
  orchestrator = new CompanyOrchestrator(db);
  companyId = orchestrator.seedCompany({
    name: "Budget",
    slug: "stream-budget",
    crew,
    departments: loadDepartmentConfig(),
  });
});
afterEach(() => db.close());

describe("streamed usage hard stop", () => {
  it.each(["company", "task", "runtime"] as const)(
    "stops before another round when the %s budget is reached",
    async (scopeType) => {
      const runtime = new MultiRoundRuntime(1000);
      orchestrator.registerRuntime(runtime);
      const task = orchestrator.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
      orchestrator.budgets.setBudget({
        companyId,
        scopeType,
        scopeId: scopeType === "task" ? task.id : scopeType === "runtime" ? "mock" : undefined,
        limitMicros: 1000,
      });

      const result = await orchestrator.executeNextTask(companyId);

      expect(runtime.nextRoundCalls).toBe(0);
      expect(runtime.abortedOnClose).toBe(true);
      expect(result?.task.status).toBe("failed");
      expect(result?.events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: { message: expect.stringContaining("Budget hard stop") },
      });
      expect(orchestrator.runs.get(result!.runId)?.status).toBe("failed");
      const cost = db
        .prepare("SELECT cost_micros, input_tokens FROM crew_cost_events WHERE run_id = ?")
        .get(result!.runId);
      expect(cost).toMatchObject({ cost_micros: 1000, input_tokens: 10_000 });
      expect(
        db
          .prepare("SELECT action FROM crew_audit_events WHERE task_id = ? AND action = 'budget.run_blocked'")
          .get(task.id),
      ).toBeTruthy();
      expect(
        db
          .prepare("SELECT action FROM crew_audit_events WHERE run_id = ? AND action = 'budget.hard_stop_reached'")
          .get(result!.runId),
      ).toBeTruthy();
    },
  );

  it("does not treat zero-cost subscription quota as money spent", async () => {
    const runtime = new MultiRoundRuntime(0);
    orchestrator.registerRuntime(runtime);
    orchestrator.budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1 });
    orchestrator.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const result = await orchestrator.executeNextTask(companyId);
    expect(runtime.nextRoundCalls).toBe(1);
    expect(result?.task.status).toBe("review");
    expect(
      db.prepare("SELECT kind, cost_micros FROM crew_cost_events WHERE run_id = ?").get(result!.runId),
    ).toMatchObject({ kind: "quota", cost_micros: 0 });
  });

  it("continues past a warning when hard stops are explicitly disabled", async () => {
    const runtime = new MultiRoundRuntime(1000);
    orchestrator.registerRuntime(runtime);
    orchestrator.budgets.setBudget({ companyId, scopeType: "company", limitMicros: 500, hardStop: false });
    orchestrator.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    expect((await orchestrator.executeNextTask(companyId))?.task.status).toBe("review");
    expect(runtime.nextRoundCalls).toBe(1);
  });
});
