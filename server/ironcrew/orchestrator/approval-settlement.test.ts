/**
 * What happens after the owner decides.
 *
 * The gap these tests close: `decideApproval` used to record the decision and
 * stop. A sensitive task — a transfer, a termination, anything the gate
 * exists for — stayed at `approval_required` forever. The owner said yes and
 * nothing happened, which is the worst possible failure for a gate, because
 * it looks like caution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { verifyAuditChain } from "../domain/audit.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

const SENSITIVE = "Bitte überweise 100 EUR an den Lieferanten.";

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Erledigt." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

function parkedTask() {
  const result = orc.handleCeoMessage(companyId, SENSITIVE);
  const approval = orc.approvals.listPending(companyId)[0];
  expect(result.task!.status).toBe("approval_required");
  return { task: result.task!, approval };
}

describe("an approved task actually runs", () => {
  it("moves out of approval_required and onto the queue", () => {
    const { task, approval } = parkedTask();

    orc.decideApproval(companyId, approval.id, "approved", "geprüft und in Ordnung");

    const after = orc.tasks.get(task.id)!;
    expect(after.status).toBe("ready");
    expect(after.assigned_agent_id).not.toBeNull();
    expect(orc.runRequests.liveForTask(task.id)?.status).toBe("queued");
  });

  it("runs to review when the queue is drained", async () => {
    const { task, approval } = parkedTask();
    orc.decideApproval(companyId, approval.id, "approved");

    const drained = await orc.drainRunQueue(companyId);

    expect(drained.completed).toBe(1);
    expect(orc.tasks.get(task.id)!.status).toBe("review");
  });

  it("picks the same agent the EA would have picked", () => {
    const { task, approval } = parkedTask();
    orc.decideApproval(companyId, approval.id, "approved");

    const agentId = orc.tasks.get(task.id)!.assigned_agent_id!;
    const agent = orc.listAgents(companyId).find((a) => a.id === agentId)!;
    // Re-derived from the description rather than a second rule for who does
    // approved work — a transfer is finance's either way.
    expect(agent.is_executive_assistant).toBe(0);
  });

  it("records the owner as the actor, not the agent", () => {
    const { task, approval } = parkedTask();
    orc.decideApproval(companyId, approval.id, "approved");

    const events = db
      .prepare(
        `SELECT actor_type, details_json FROM crew_audit_events
          WHERE task_id = ? AND action = 'task.transitioned' ORDER BY seq DESC LIMIT 1`,
      )
      .get(task.id) as { actor_type: string; details_json: string };
    expect(events.actor_type).toBe("owner");
    expect(events.details_json).toContain("freigegeben");
  });
});

describe("a rejected task does not linger", () => {
  it("is cancelled, carrying the owner's reason", () => {
    const { task, approval } = parkedTask();

    orc.decideApproval(companyId, approval.id, "rejected", "nicht autorisiert");

    const after = orc.tasks.get(task.id)!;
    // Not left at approval_required looking like it might still happen.
    expect(after.status).toBe("cancelled");
    expect(orc.runRequests.list(companyId)).toHaveLength(0);
  });

  it("never queues a run for refused work", async () => {
    const { approval } = parkedTask();
    orc.decideApproval(companyId, approval.id, "rejected", "nein");

    expect(await orc.drainRunQueue(companyId)).toMatchObject({ claimed: 0 });
  });
});

describe("it touches only the task it should", () => {
  it("leaves a task alone when the approval was raised mid-run", async () => {
    // MockRuntime's approval_required scenario raises an approval from inside
    // a run; that run is still in progress and must not be restarted.
    const orc2 = new CompanyOrchestrator(db);
    orc2.registerRuntime(new MockRuntime({ scenario: "approval_required" }));
    orc2.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const executed = await orc2.executeNextTask(companyId);
    expect(executed!.task.status).toBe("waiting");

    const approval = orc2.approvals.listPending(companyId).at(-1)!;
    const before = orc2.tasks.get(executed!.task.id)!.status;
    orc2.decideApproval(companyId, approval.id, "approved");

    expect(orc2.tasks.get(executed!.task.id)!.status).toBe(before);
  });

  it("leaves a change proposal's approval to applyChangeProposal", () => {
    const proposed = orc.proposeChanges(companyId, {
      title: "Konfiguration anpassen",
      workspacePath: "/tmp",
      files: [{ path: "a.txt", operation: "create", content: "x" }],
    });

    // A file_change approval has no parked task at all; settling must be a
    // no-op rather than inventing one.
    expect(() => orc.decideApproval(companyId, proposed.approvalId, "approved")).not.toThrow();
    expect(orc.runRequests.list(companyId)).toHaveLength(0);
  });

  it("does nothing for an approval with no task", () => {
    const approval = orc.approvals.request(companyId, {
      approvalType: "irreversible_data_change",
      requestedBy: "agent",
      summary: "Ohne Aufgabe",
      riskLevel: "high",
    });
    expect(() => orc.decideApproval(companyId, approval.id, "approved")).not.toThrow();
  });

  it("is idempotent — a second decision changes nothing", async () => {
    const { task, approval } = parkedTask();
    orc.decideApproval(companyId, approval.id, "approved");
    await orc.drainRunQueue(companyId);
    const afterRun = orc.tasks.get(task.id)!.status;

    // The approval is already decided, so this returns null and settles nothing.
    expect(orc.decideApproval(companyId, approval.id, "rejected", "doch nicht")).toBeNull();
    expect(orc.tasks.get(task.id)!.status).toBe(afterRun);
  });
});

it("keeps the audit chain intact through the whole cycle", async () => {
  const { approval } = parkedTask();
  orc.decideApproval(companyId, approval.id, "approved", "ok");
  await orc.drainRunQueue(companyId);
  expect(verifyAuditChain(db, companyId).valid).toBe(true);
});
