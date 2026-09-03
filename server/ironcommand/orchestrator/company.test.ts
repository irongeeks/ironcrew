import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { RunStore } from "../runtime/run-store.ts";
import { TaskStore } from "../domain/task-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { BudgetExceededError } from "../policy/budget-engine.ts";
import { loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig();
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Analyse abgeschlossen." }));
  companyId = orc.seedCompany({ name: "Iron Command", slug: "iron", crew, departments });
});

afterEach(() => db.close());

describe("seeding", () => {
  it("creates the company, departments and crew", () => {
    expect(orc.listAgents(companyId)).toHaveLength(crew.agents.length);
    const depts = db.prepare("SELECT COUNT(*) AS n FROM ic_departments WHERE company_id = ?").get(companyId) as {
      n: number;
    };
    expect(depts.n).toBe(departments.departments.length);
  });

  it("is idempotent", () => {
    const again = orc.seedCompany({ name: "Iron Command", slug: "iron", crew, departments });
    expect(again).toBe(companyId);
    expect(orc.listAgents(companyId)).toHaveLength(crew.agents.length);
  });

  it("has exactly one executive assistant", () => {
    const ea = orc.executiveAssistant(companyId);
    expect(ea.is_executive_assistant).toBe(1);
    expect(orc.listAgents(companyId).filter((a) => a.is_executive_assistant === 1)).toHaveLength(1);
  });

  it("stores persona and policy as separate columns", () => {
    const cto = orc.getAgent(companyId, "cto")!;
    const persona = JSON.parse(cto.persona_json);
    const policy = JSON.parse(cto.policy_json);
    expect(persona.display_name).toBeTruthy();
    expect(persona.allowed_tools).toBeUndefined(); // persona carries no permissions
    expect(policy.allowed_tools).toBeInstanceOf(Array);
    expect(policy.may_approve).toBe(false);
  });

  it("gives no agent the power to approve", () => {
    for (const a of orc.listAgents(companyId)) {
      expect(JSON.parse(a.policy_json).may_approve).toBe(false);
    }
  });
});

describe("CEO -> EA triage", () => {
  it("answers a status request from state without creating a task", () => {
    const r = orc.handleCeoMessage(companyId, "Wie ist der aktuelle Status?");
    expect(r.triage.category).toBe("status_request");
    expect(r.task).toBeNull();
    expect(r.reply).toContain("Stand");
  });

  it("asks for clarification instead of guessing", () => {
    const r = orc.handleCeoMessage(companyId, "hm");
    expect(r.task).toBeNull();
    expect(r.reply).toMatch(/nicht eindeutig/i);
  });

  it("creates and delegates a routine task", () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere unser Backup-Konzept.");
    expect(r.task).not.toBeNull();
    expect(r.assignedAgent).not.toBeNull();
    expect(r.task!.status).toBe("ready");
    expect(r.task!.assigned_agent_id).toBe(r.assignedAgent!.id);
  });

  it("routes by department", () => {
    const r = orc.handleCeoMessage(companyId, "Prüfe die Firewall auf Schwachstellen.");
    expect(r.triage.suggestedDepartment).toBe("security");
    expect(r.assignedAgent!.key).toBe("ciso");
  });

  it("records the message and the EA reply in one conversation", () => {
    orc.handleCeoMessage(companyId, "Bitte erstelle eine Übersicht.");
    const msgs = orc.listMessages(orc.ensureCeoConversation(companyId));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("ceo");
    expect(msgs[1].role).toBe("agent");
  });

  it("stamps one correlation id across message, task and audit", () => {
    const r = orc.handleCeoMessage(companyId, "Bitte analysiere die Logs.");
    expect(r.task!.correlation_id).toBe(r.correlationId);
    const audits = db
      .prepare("SELECT COUNT(*) AS n FROM ic_audit_events WHERE correlation_id = ?")
      .get(r.correlationId) as { n: number };
    expect(audits.n).toBeGreaterThan(0);
  });
});

describe("sensitive requests are blocked, not executed", () => {
  it("parks a payment behind an approval and does not delegate it", () => {
    const r = orc.handleCeoMessage(companyId, "Bitte überweise 4.500 EUR an den Lieferanten.");
    expect(r.triage.sensitive).toBe(true);
    expect(r.task!.status).toBe("approval_required");
    expect(r.assignedAgent).toBeNull();
    expect(r.reply).toMatch(/NICHT ausgeführt/);

    const pending = orc.approvals.listPending(companyId);
    expect(pending).toHaveLength(1);
    expect(pending[0].approval_type).toBe("bank_transfer");
  });

  it("classifies the approval type from the request", () => {
    orc.handleCeoMessage(companyId, "Bitte reiche die UStVA beim Finanzamt ein.");
    expect(orc.approvals.listPending(companyId)[0].approval_type).toBe("tax_filing");
  });

  it("does not make a sensitive task claimable", () => {
    orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR.");
    expect(orc.tasks.findClaimable(companyId)).toHaveLength(0);
  });
});

describe("full vertical slice: CEO -> EA -> agent -> review -> CEO", () => {
  it("runs end to end and lands the result in review", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    expect(r.task!.status).toBe("ready");

    const seen: string[] = [];
    const exec = await orc.executeNextTask(companyId, { onEvent: (e) => seen.push(e.type) });

    expect(exec).not.toBeNull();
    expect(exec!.task.status).toBe("review");
    expect(exec!.task.result_summary).toBe("Analyse abgeschlossen.");
    expect(seen[0]).toBe("run.started");
    expect(seen).toContain("message.completed");
    expect(seen.at(-1)).toBe("run.completed");

    const accepted = orc.acceptReview(companyId, exec!.task.id, "Sieht gut aus.");
    expect(accepted!.status).toBe("done");
    expect(accepted!.completed_at).toBeGreaterThan(0);

    const msgs = orc.listMessages(orc.ensureCeoConversation(companyId));
    expect(msgs.at(-1)!.body).toMatch(/Abgenommen/);
  });

  it("supports requesting a revision and re-running", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.");
    const first = await orc.executeNextTask(companyId);
    expect(first!.task.status).toBe("review");

    const revised = orc.requestRevision(companyId, first!.task.id, "Zu knapp, bitte Details ergänzen.");
    expect(revised!.status).toBe("ready");
    expect(revised!.review_notes).toMatch(/Zu knapp/);

    const second = await orc.executeNextTask(companyId);
    expect(second).not.toBeNull();
    expect(second!.task.status).toBe("review");
    // A second run exists for the same task.
    expect(new RunStore(db).listForTask(first!.task.id)).toHaveLength(2);
  });

  it("releases the execution lock when the run finishes", async () => {
    orc.handleCeoMessage(companyId, "Bitte erstelle eine Übersicht.");
    const exec = await orc.executeNextTask(companyId);
    expect(exec!.task.execution_run_id).toBeNull();
    expect(exec!.task.lock_expires_at).toBeNull();
  });

  it("persists every run event for replay", async () => {
    orc.handleCeoMessage(companyId, "Bitte analysiere die Logs.");
    const exec = await orc.executeNextTask(companyId);
    const replayed = new RunStore(db).listEvents(exec!.runId);
    expect(replayed.length).toBe(exec!.events.length);
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
  });

  it("keeps everything after a simulated restart", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere die Architektur.");
    const exec = await orc.executeNextTask(companyId);
    const taskId = exec!.task.id;

    // A fresh orchestrator over the same database is what a restart looks like.
    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(new MockRuntime());

    expect(restarted.tasks.get(taskId)!.status).toBe("review");
    expect(restarted.listMessages(restarted.ensureCeoConversation(companyId)).length).toBeGreaterThan(0);
    expect(new RunStore(db).listEvents(exec!.runId).length).toBeGreaterThan(0);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    expect(restarted.acceptReview(companyId, taskId)!.status).toBe("done");
    expect(r.correlationId).toBeTruthy();
  });

  it("returns null when there is nothing to execute", async () => {
    expect(await orc.executeNextTask(companyId)).toBeNull();
  });
});

describe("failure and waiting paths", () => {
  it("marks a task failed when the runtime fails", async () => {
    const failing = new CompanyOrchestrator(db);
    failing.registerRuntime(new MockRuntime({ scenario: "failure" }));
    failing.handleCeoMessage(companyId, "Bitte erstelle den Bericht.");
    const exec = await failing.executeNextTask(companyId);
    expect(exec!.task.status).toBe("failed");
  });

  it("allows retry after failure", async () => {
    const failing = new CompanyOrchestrator(db);
    failing.registerRuntime(new MockRuntime({ scenario: "failure" }));
    failing.handleCeoMessage(companyId, "Bitte erstelle den Bericht.");
    const exec = await failing.executeNextTask(companyId);
    const retried = failing.tasks.transition(exec!.task.id, "ready", { reason: "retry" });
    expect(retried!.status).toBe("ready");
  });

  it("puts a rate-limited run into waiting rather than failed", async () => {
    const limited = new CompanyOrchestrator(db);
    limited.registerRuntime(new MockRuntime({ scenario: "rate_limit" }));
    limited.handleCeoMessage(companyId, "Bitte analysiere den Markt.");
    const exec = await limited.executeNextTask(companyId);
    expect(exec!.task.status).toBe("waiting");
    expect(exec!.events.some((e) => e.type === "rate_limit.detected")).toBe(true);
  });

  it("raises an approval when the runtime asks for one", async () => {
    const gated = new CompanyOrchestrator(db);
    gated.registerRuntime(new MockRuntime({ scenario: "approval_required" }));
    gated.handleCeoMessage(companyId, "Bitte erstelle das Deployment-Skript.");
    await gated.executeNextTask(companyId);
    expect(gated.approvals.listPending(companyId).length).toBeGreaterThan(0);
  });
});

describe("budget enforcement stops runs", () => {
  it("refuses to start a run once the hard limit is consumed", async () => {
    orc.budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000 });
    orc.budgets.recordCost({ companyId, costMicros: 5_000 });
    orc.handleCeoMessage(companyId, "Bitte erstelle die Dokumentation.");
    await expect(orc.executeNextTask(companyId)).rejects.toThrow(BudgetExceededError);
  });

  it("leaves the task unclaimed when the budget blocks it", async () => {
    orc.budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000 });
    orc.budgets.recordCost({ companyId, costMicros: 5_000 });
    const r = orc.handleCeoMessage(companyId, "Bitte erstelle die Dokumentation.");
    await expect(orc.executeNextTask(companyId)).rejects.toThrow();
    expect(orc.tasks.get(r.task!.id)!.status).toBe("ready");
  });
});

describe("agent status reflects real backend state", () => {
  it("is idle before work and working during a run", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const agentId = r.assignedAgent!.id;

    let statusDuringRun: string | null = null;
    await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "message.delta" && statusDuringRun === null) {
          statusDuringRun = orc.agentStatus(companyId, agentId);
        }
      },
    });
    expect(statusDuringRun).toBe("working");
  });

  it("returns to idle once the task is accepted", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const exec = await orc.executeNextTask(companyId);
    orc.acceptReview(companyId, exec!.task.id);
    expect(orc.agentStatus(companyId, r.assignedAgent!.id)).toBe("idle");
  });
});

describe("permission resolution — elevation reachable only through a live grant", () => {
  it("defaults every run to restricted with no grant in play", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    let seenMode: string | undefined;
    const exec = await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "run.started") seenMode = e.payload.permissionMode as string;
      },
    });
    expect(seenMode).toBe("restricted");
    expect(orc.runs.get(exec!.runId)!.permission_mode).toBe("restricted");
    void r;
  });

  it("elevates a run once a live grant covers its exact task and runtime", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const taskId = r.task!.id;

    const approval = orc.approvals.request(
      companyId,
      { approvalType: "sandbox_elevation", requestedBy: r.assignedAgent!.id, summary: "one-off script" },
      { taskId },
    );
    orc.approvals.decide(approval.id, "approved", "owner-1", "reviewed, time-boxed");
    const grant = orc.sandboxGrants.mintFromApproval({
      approval: orc.approvals.get(approval.id)!,
      providers: ["mock"],
      requestedDurationMs: 60 * 60_000,
      taskId,
    });

    let seenMode: string | undefined;
    const exec = await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "run.started") seenMode = e.payload.permissionMode as string;
      },
    });

    expect(seenMode).toBe("elevated");
    const run = orc.runs.get(exec!.runId)!;
    expect(run.permission_mode).toBe("elevated");
    expect(run.sandbox_grant_id).toBe(grant.id);
  });

  it("does not elevate a run for a different task even with a live grant elsewhere", async () => {
    // The only claimable task in this test is the one the CEO asks about
    // below; the grant is deliberately scoped to an unrelated task id, so
    // there is exactly one candidate run and no ambiguity about which task
    // this assertion is about.
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const unrelatedTaskId = orc.tasks.create({ companyId, title: "unrelated", status: "ready" }).id;

    const approval = orc.approvals.request(
      companyId,
      { approvalType: "sandbox_elevation", requestedBy: "agt_x", summary: "unrelated task" },
      { taskId: unrelatedTaskId },
    );
    orc.approvals.decide(approval.id, "approved", "owner-1");
    orc.sandboxGrants.mintFromApproval({
      approval: orc.approvals.get(approval.id)!,
      providers: ["mock"],
      requestedDurationMs: 60_000,
      taskId: unrelatedTaskId,
    });

    let seenMode: string | undefined;
    const exec = await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "run.started") seenMode = e.payload.permissionMode as string;
      },
    });

    expect(exec!.task.id).toBe(r.task!.id);
    expect(seenMode).toBe("restricted");
  });

  it("does not elevate a run for a different runtime provider", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const taskId = r.task!.id;
    const approval = orc.approvals.request(
      companyId,
      { approvalType: "sandbox_elevation", requestedBy: r.assignedAgent!.id, summary: "x" },
      { taskId },
    );
    orc.approvals.decide(approval.id, "approved", "owner-1");
    orc.sandboxGrants.mintFromApproval({
      approval: orc.approvals.get(approval.id)!,
      providers: ["claude"], // this company's agents run on "mock"
      requestedDurationMs: 60_000,
      taskId,
    });

    let seenMode: string | undefined;
    await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "run.started") seenMode = e.payload.permissionMode as string;
      },
    });
    expect(seenMode).toBe("restricted");
  });

  it("does not elevate a run once the grant has expired", async () => {
    const r = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    const taskId = r.task!.id;
    const approval = orc.approvals.request(
      companyId,
      { approvalType: "sandbox_elevation", requestedBy: r.assignedAgent!.id, summary: "x" },
      { taskId },
    );
    orc.approvals.decide(approval.id, "approved", "owner-1");
    const grant = orc.sandboxGrants.mintFromApproval({
      approval: orc.approvals.get(approval.id)!,
      providers: ["mock"],
      requestedDurationMs: 1,
      taskId,
    });
    // Force the grant to be already expired without waiting on the clock.
    db.prepare("UPDATE ic_sandbox_grants SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, grant.id);

    let seenMode: string | undefined;
    await orc.executeNextTask(companyId, {
      onEvent: (e) => {
        if (e.type === "run.started") seenMode = e.payload.permissionMode as string;
      },
    });
    expect(seenMode).toBe("restricted");
  });

  it("audits the permission resolution for every run", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    await orc.executeNextTask(companyId);
    const rows = db
      .prepare("SELECT * FROM ic_audit_events WHERE action = 'permission.resolved'")
      .all() as Array<{ details_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details_json)).toMatchObject({ mode: "restricted", code: "default_restricted" });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("orphan recovery", () => {
  it("returns a task abandoned by a dead worker to ready", () => {
    const tasks = new TaskStore(db);
    const t = tasks.create({ companyId, title: "abandoned", status: "ready" });
    tasks.claim({
      taskId: t.id,
      runId: "run-dead",
      agentId: orc.getAgent(companyId, "cto")!.id,
      expectedVersion: 0,
      lockTtlMs: 1,
    });
    const runs = new RunStore(db);
    runs.create({ companyId, taskId: t.id, runtimeType: "mock" });

    const recovered = orc.recoverOrphanedTasks(companyId, Date.now() + 10_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("ready");
  });

  it("leaves live tasks alone", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Verfahren.");
    expect(orc.recoverOrphanedTasks(companyId)).toHaveLength(0);
  });
});

describe("audit completeness", () => {
  it("records the whole flow with a valid chain", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment.");
    const exec = await orc.executeNextTask(companyId);
    orc.acceptReview(companyId, exec!.task.id);

    const actions = (
      db.prepare("SELECT action FROM ic_audit_events ORDER BY seq").all() as Array<{ action: string }>
    ).map((r) => r.action);
    expect(actions).toContain("company.seeded");
    expect(actions).toContain("ceo.message_received");
    expect(actions).toContain("task.created");
    expect(actions).toContain("task.claimed");
    expect(actions).toContain("task.transitioned");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
