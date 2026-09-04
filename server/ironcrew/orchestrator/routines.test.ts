/**
 * Recurring work that leaves a trace.
 *
 * The rule Phase 3 asks for is one sentence — "every routine produces a
 * visible task or run, never an invisible background action" — and it is the
 * only thing these tests are really about. A routine that acted directly
 * would be invisible to the board, to the approval gates, to the budget
 * engine and to the audit log, and the first evidence of a misfiring one
 * would be the damage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { RoutineMutationError } from "../domain/routine-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Erledigt." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

function routine(over: Record<string, unknown> = {}) {
  return orc.routines.create(
    {
      companyId,
      name: "Backup prüfen",
      instruction: "Bitte prüfe, ob das nächtliche Backup durchgelaufen ist.",
      intervalMinutes: 60,
      ...over,
    },
    { now: T0 },
  );
}

describe("creating a routine", () => {
  it("does not fire it immediately", () => {
    const created = routine();
    // Otherwise an operator adjusting the form would start a run every time
    // they touched it.
    expect(created.next_run_at).toBe(T0 + 60 * 60_000);
    expect(orc.tasks.list(companyId)).toHaveLength(0);
  });

  it("refuses what would have nothing to do or no way to be found", () => {
    expect(() => routine({ name: "  " })).toThrow(RoutineMutationError);
    expect(() => routine({ instruction: "   " })).toThrow(RoutineMutationError);
    expect(() => routine({ intervalMinutes: 0 })).toThrow(RoutineMutationError);
    expect(() => routine({ intervalMinutes: 60 * 24 * 365 })).toThrow(/Kalender/);
  });

  it("refuses a duplicate name", () => {
    routine();
    expect(() => routine()).toThrow(/bereits/);
  });
});

describe("firing produces a task, not an action", () => {
  it("creates a task carrying the owner's own words", () => {
    const created = routine();
    const result = orc.runDueRoutines(companyId, { now: created.next_run_at });

    expect(result.fired).toBe(1);
    const task = result.tasks[0];
    expect(task.description).toBe("Bitte prüfe, ob das nächtliche Backup durchgelaufen ist.");
    expect(task.title).toContain("Backup prüfen");
    expect(task.created_by).toBe(`routine:${created.id}`);
  });

  it("delegates and queues it, so it actually runs", async () => {
    const created = routine();
    orc.runDueRoutines(companyId, { now: created.next_run_at });

    const request = orc.runRequests.list(companyId)[0];
    expect(request).toBeTruthy();
    expect(await orc.drainRunQueue(companyId)).toMatchObject({ completed: 1 });
  });

  it("links the task back to the routine that asked for it", () => {
    const created = routine();
    const result = orc.runDueRoutines(companyId, { now: created.next_run_at });
    // "What did this routine actually do" should be one click, not an
    // investigation.
    expect(orc.routines.get(created.id)!.last_task_id).toBe(result.tasks[0].id);
    expect(orc.routines.get(created.id)!.run_count).toBe(1);
  });

  it("records the firing in the audit log", () => {
    const created = routine();
    orc.runDueRoutines(companyId, { now: created.next_run_at });

    const fired = db.prepare("SELECT details_json FROM crew_audit_events WHERE action = 'routine.fired'").get() as
      | { details_json: string }
      | undefined;
    expect(fired?.details_json).toContain("Backup prüfen");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("routes to the agent the routine names", () => {
    const agent = orc.listAgents(companyId).find((a) => a.key === "finance")!;
    const created = routine({ agentId: agent.id });
    const result = orc.runDueRoutines(companyId, { now: created.next_run_at });
    expect(result.tasks[0].assigned_agent_id).toBe(agent.id);
  });

  it("parks a sensitive routine behind an approval, exactly like a typed request", () => {
    const created = routine({
      name: "Monatliche Zahlung",
      instruction: "Bitte überweise 100 EUR an den Lieferanten.",
    });
    const result = orc.runDueRoutines(companyId, { now: created.next_run_at });

    // A timer must not be a way around the gate.
    expect(result.tasks[0].status).toBe("approval_required");
    expect(orc.approvals.listPending(companyId)).toHaveLength(1);
    expect(orc.runRequests.list(companyId)).toHaveLength(0);
  });
});

describe("scheduling", () => {
  it("fires nothing before it is due", () => {
    const created = routine();
    expect(orc.runDueRoutines(companyId, { now: created.next_run_at - 1 })).toMatchObject({ fired: 0 });
  });

  it("advances the schedule as part of the claim, so a second tick fires nothing", () => {
    const created = routine();
    const at = created.next_run_at;

    expect(orc.runDueRoutines(companyId, { now: at }).fired).toBe(1);
    // The advance is in the same statement as the claim: two overlapping
    // ticks cannot both fire one routine.
    expect(orc.runDueRoutines(companyId, { now: at }).fired).toBe(0);
    expect(orc.routines.get(created.id)!.next_run_at).toBe(at + 60 * 60_000);
  });

  it("fires again in the next window", () => {
    const created = routine();
    orc.runDueRoutines(companyId, { now: created.next_run_at });
    expect(orc.runDueRoutines(companyId, { now: created.next_run_at + 60 * 60_000 }).fired).toBe(1);
  });

  it("stops at the limit rather than stampeding", () => {
    const first = routine({ name: "A" });
    routine({ name: "B" });
    routine({ name: "C" });
    expect(orc.runDueRoutines(companyId, { now: first.next_run_at, limit: 2 }).fired).toBe(2);
  });

  it("skips a disabled routine", () => {
    const created = routine();
    orc.routines.setEnabled(created.id, false, { now: T0 });
    expect(orc.runDueRoutines(companyId, { now: created.next_run_at }).fired).toBe(0);
  });

  it("does not fire the moment it is re-enabled", () => {
    const created = routine();
    orc.routines.setEnabled(created.id, false, { now: T0 });
    const resumedAt = created.next_run_at + 7 * 24 * 60 * 60_000;
    orc.routines.setEnabled(created.id, true, { now: resumedAt });

    // A routine paused for a week firing instantly on resume is never what
    // pausing meant.
    expect(orc.runDueRoutines(companyId, { now: resumedAt }).fired).toBe(0);
    expect(orc.runDueRoutines(companyId, { now: resumedAt + 60 * 60_000 }).fired).toBe(1);
  });

  it("re-bases the schedule when the interval changes", () => {
    const created = routine();
    const changedAt = T0 + 1000;
    orc.routines.update(created.id, { intervalMinutes: 5 }, { now: changedAt });
    // Shortening the interval must not leave it waiting out the old, longer one.
    expect(orc.routines.get(created.id)!.next_run_at).toBe(changedAt + 5 * 60_000);
  });
});

describe("running one on demand", () => {
  it("fires whatever the schedule says", () => {
    const created = routine();
    const task = orc.runRoutineNow(companyId, created.id);
    expect(task).not.toBeNull();
    expect(task!.description).toContain("Backup");
  });

  it("returns null for a routine that is not this company's", () => {
    expect(orc.runRoutineNow(companyId, "rtn_nope")).toBeNull();
  });
});

describe("editing and removing", () => {
  it("renames without losing the schedule", () => {
    const created = routine();
    const renamed = orc.routines.update(created.id, { name: "Backup kontrollieren" }, { now: T0 + 5 })!;
    expect(renamed.name).toBe("Backup kontrollieren");
    expect(renamed.next_run_at).toBe(created.next_run_at);
  });

  it("refuses a rename onto an existing name", () => {
    routine({ name: "A" });
    const second = routine({ name: "B" });
    expect(() => orc.routines.update(second.id, { name: "A" })).toThrow(RoutineMutationError);
  });

  it("deletes, and stops firing", () => {
    const created = routine();
    expect(orc.routines.delete(created.id)).toBe(true);
    expect(orc.runDueRoutines(companyId, { now: created.next_run_at }).fired).toBe(0);
    expect(orc.routines.delete(created.id)).toBe(false);
  });

  it("returns null for a routine that does not exist", () => {
    expect(orc.routines.get("rtn_nope")).toBeNull();
    expect(orc.routines.update("rtn_nope", { name: "x" })).toBeNull();
    expect(orc.routines.setEnabled("rtn_nope", false)).toBeNull();
  });
});
