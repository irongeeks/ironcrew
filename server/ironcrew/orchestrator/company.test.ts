import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { RunStore } from "../runtime/run-store.ts";
import { TaskStore } from "../domain/task-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { BudgetExceededError } from "../policy/budget-engine.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import type { AgentRuntime, RunContext, RunInput } from "../runtime/run-events.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

// Explicitly bypass any private, gitignored character-pack.local.yaml a
// developer's machine might have on disk — this crew is used as an
// explicit seedCompany() override below, so it must be identical in every
// environment regardless of local dev state (see the same guard in
// crew-config.test.ts).
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Analyse abgeschlossen." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

describe("seeding", () => {
  it("creates the company, departments and crew", () => {
    expect(orc.listAgents(companyId)).toHaveLength(crew.agents.length);
    const depts = db.prepare("SELECT COUNT(*) AS n FROM crew_departments WHERE company_id = ?").get(companyId) as {
      n: number;
    };
    expect(depts.n).toBe(departments.departments.length);
  });

  it("is idempotent", () => {
    const again = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
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
      .prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE correlation_id = ?")
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

  it("puts a notification in the inbox for the pending approval", () => {
    orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR.");
    const approval = orc.approvals.listPending(companyId)[0];
    const notifications = orc.notifications.list(companyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].approval_id).toBe(approval.id);
    expect(notifications[0].kind).toBe("approval_required");
    expect(notifications[0].read_at).toBeNull();
  });
});

describe("decideApproval — decision log and inbox clearing", () => {
  it("records a decision and clears the notification when approved", () => {
    orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR.");
    const approval = orc.approvals.listPending(companyId)[0];

    const decided = orc.decideApproval(companyId, approval.id, "approved", "geprüft, in Ordnung");
    expect(decided!.status).toBe("approved");

    const decisions = orc.decisions.list(companyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("approved");
    expect(decisions[0].rationale).toBe("geprüft, in Ordnung");

    const notification = orc.notifications.list(companyId)[0];
    expect(notification.read_at).not.toBeNull();
  });

  it("records a rejected decision too", () => {
    orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR.");
    const approval = orc.approvals.listPending(companyId)[0];
    orc.decideApproval(companyId, approval.id, "rejected", "nicht autorisiert");
    expect(orc.decisions.list(companyId)[0].decision).toBe("rejected");
  });

  it("returns null for an approval that does not exist or was already decided", () => {
    expect(orc.decideApproval(companyId, "apr_nope", "approved")).toBeNull();

    orc.handleCeoMessage(companyId, "Bitte überweise 100 EUR.");
    const approval = orc.approvals.listPending(companyId)[0];
    orc.decideApproval(companyId, approval.id, "approved");
    expect(orc.decideApproval(companyId, approval.id, "approved")).toBeNull();
    // Only the one decision from the first, successful call.
    expect(orc.decisions.list(companyId)).toHaveLength(1);
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

describe("runtime selection", () => {
  it("lists every registered runtime", () => {
    expect(orc.listRuntimes().map((r) => r.type)).toEqual(["mock"]);
  });

  it("moves an agent onto a different registered runtime and audits it", () => {
    orc.registerRuntime(new MockRuntime({ responseText: "zweite Instanz" }));
    // Same type ("mock") is fine here — the point under test is the write
    // path and audit trail, not routing to a genuinely distinct provider
    // (that's covered by the real CliAdapterRuntime tests).
    const agent = orc.getAgent(companyId, "finance")!;
    expect(agent.runtime_provider).toBe("mock");

    const updated = orc.setAgentRuntimeProvider(companyId, agent.id, "mock");
    expect(updated!.runtime_provider).toBe("mock");

    const rows = db
      .prepare("SELECT action, details_json FROM crew_audit_events WHERE action = 'agent.runtime_changed'")
      .all() as Array<{
      action: string;
      details_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details_json)).toEqual({ from: "mock", to: "mock" });
  });

  it("returns null for an agent outside the company", () => {
    expect(orc.setAgentRuntimeProvider(companyId, "agt_nope", "mock")).toBeNull();
  });

  it("refuses an unregistered runtime provider", () => {
    const agent = orc.getAgent(companyId, "finance")!;
    expect(() => orc.setAgentRuntimeProvider(companyId, agent.id, "claude")).toThrow(/Unknown runtime provider/);
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
    db.prepare("UPDATE crew_sandbox_grants SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, grant.id);

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
    const rows = db.prepare("SELECT * FROM crew_audit_events WHERE action = 'permission.resolved'").all() as Array<{
      details_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details_json)).toMatchObject({ mode: "restricted", code: "default_restricted" });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("goal ancestry in the run context", () => {
  /**
   * Captures the prompt a run actually receives — MockRuntime doesn't echo
   * it back in any event, so this is the minimal double that lets the test
   * observe what executeNextTask() built, not just that it ran.
   */
  class PromptCapturingRuntime implements AgentRuntime {
    readonly id = "capture";
    readonly type = "capture";
    receivedPrompt: string | null = null;

    async capabilities() {
      return {
        streaming: false,
        sessionResume: false,
        usageReporting: false,
        costReporting: false,
        toolCalls: false,
        subagents: false,
        defaultConcurrency: 1,
      };
    }
    async healthCheck() {
      return { healthy: true, installed: true, detail: "", checkedAt: Date.now() };
    }
    async authStatus() {
      return { authenticated: true, method: "none" as const, detail: "" };
    }
    async cancelRun(): Promise<void> {}

    async *startRun(input: RunInput, context: RunContext) {
      this.receivedPrompt = input.prompt;
      yield {
        eventId: "evt_capture",
        companyId: context.companyId,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        seq: 0,
        type: "run.completed" as const,
        timestamp: Date.now(),
        correlationId: context.correlationId,
        payload: { summary: "ok" },
        redaction: { redacted: false, rules: [] },
      };
    }
  }

  it("tells the agent why the task matters when its project traces to a goal", async () => {
    const capture = new PromptCapturingRuntime();
    orc.registerRuntime(capture);

    const goal = orc.goals.create({ companyId, title: "Grow revenue 20%" });
    const project = orc.projects.create({ companyId, title: "Pricing page", goalId: goal.id });
    const cto = orc.getAgent(companyId, "cto")!;
    orc.tasks.create({
      companyId,
      title: "Redesign pricing",
      status: "ready",
      projectId: project.id,
      assignedAgentId: cto.id,
    });

    await orc.executeNextTask(companyId, { runtimeType: "capture" });

    expect(capture.receivedPrompt).toContain("Strategischer Kontext");
    expect(capture.receivedPrompt).toContain("Pricing page");
    expect(capture.receivedPrompt).toContain("Grow revenue 20%");
    // The strategic-context block comes before the task section, never replacing it.
    expect(capture.receivedPrompt!.indexOf("Strategischer Kontext")).toBeLessThan(
      capture.receivedPrompt!.indexOf("# Aufgabe"),
    );
  });

  it("adds no strategic-context block when the project has no goal", async () => {
    const capture = new PromptCapturingRuntime();
    orc.registerRuntime(capture);

    const project = orc.projects.create({ companyId, title: "Ad-hoc cleanup" });
    const cto = orc.getAgent(companyId, "cto")!;
    orc.tasks.create({
      companyId,
      title: "Tidy the workspace",
      status: "ready",
      projectId: project.id,
      assignedAgentId: cto.id,
    });

    await orc.executeNextTask(companyId, { runtimeType: "capture" });
    expect(capture.receivedPrompt).not.toContain("Strategischer Kontext");
  });

  it("adds no strategic-context block for a task with no project at all", async () => {
    const capture = new PromptCapturingRuntime();
    orc.registerRuntime(capture);

    const cto = orc.getAgent(companyId, "cto")!;
    orc.tasks.create({ companyId, title: "Standalone task", status: "ready", assignedAgentId: cto.id });

    await orc.executeNextTask(companyId, { runtimeType: "capture" });
    expect(capture.receivedPrompt).not.toContain("Strategischer Kontext");
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
      db.prepare("SELECT action FROM crew_audit_events ORDER BY seq").all() as Array<{ action: string }>
    ).map((r) => r.action);
    expect(actions).toContain("company.seeded");
    expect(actions).toContain("ceo.message_received");
    expect(actions).toContain("task.created");
    expect(actions).toContain("task.claimed");
    expect(actions).toContain("task.transitioned");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("secret providers", () => {
  it("resolveSecret dispatches to the registered provider for that ref's kind", async () => {
    const s = orc.secrets.create({ companyId, name: "gh-pat", provider: "protonpass", itemRef: "s1:i1" });
    orc.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => "resolved-value",
      testConnection: async () => ({ ok: true, message: "ok" }),
    });
    const value = await orc.resolveSecret(companyId, s.id);
    expect(value).toBe("resolved-value");
  });

  it("resolveSecret throws when no provider is registered for that kind", async () => {
    const s = orc.secrets.create({ companyId, name: "gh-pat", provider: "vaultwarden", itemRef: "github" });
    await expect(orc.resolveSecret(companyId, s.id)).rejects.toThrow(/No "vaultwarden" provider/);
  });

  it("resolveSecret throws for an unknown or cross-company secret id", async () => {
    await expect(orc.resolveSecret(companyId, "secret_nope")).rejects.toThrow();
  });

  it("audits a successful resolution without ever including the resolved value", async () => {
    const s = orc.secrets.create({ companyId, name: "gh-pat", provider: "protonpass", itemRef: "s1:i1" });
    orc.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => "super-secret-value",
      testConnection: async () => ({ ok: true, message: "ok" }),
    });
    await orc.resolveSecret(companyId, s.id);

    const rows = db
      .prepare("SELECT action, outcome, details_json FROM crew_audit_events WHERE company_id = ? AND entity_id = ?")
      .all(companyId, s.id) as Array<{ action: string; outcome: string; details_json: string }>;
    const resolved = rows.find((r) => r.action === "secret.resolved");
    expect(resolved?.outcome).toBe("ok");
    expect(resolved?.details_json).not.toMatch(/super-secret-value/);
  });

  it("audits a failed resolution too, with outcome 'failed' and no leaked value", async () => {
    const s = orc.secrets.create({ companyId, name: "gh-pat", provider: "protonpass", itemRef: "s1:i1" });
    orc.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => {
        throw new Error("not found");
      },
      testConnection: async () => ({ ok: true, message: "ok" }),
    });
    await expect(orc.resolveSecret(companyId, s.id)).rejects.toThrow("not found");

    const rows = db
      .prepare("SELECT action, outcome FROM crew_audit_events WHERE company_id = ? AND entity_id = ?")
      .all(companyId, s.id) as Array<{ action: string; outcome: string }>;
    const resolved = rows.find((r) => r.action === "secret.resolved");
    expect(resolved?.outcome).toBe("failed");
  });

  it("testSecretProvider reports not-ok when nothing is registered for that kind", async () => {
    const status = await orc.testSecretProvider("vaultwarden");
    expect(status.ok).toBe(false);
  });

  it("listSecretProviderKinds reflects registrations", () => {
    expect(orc.listSecretProviderKinds()).toEqual([]);
    orc.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => "x",
      testConnection: async () => ({ ok: true, message: "ok" }),
    });
    expect(orc.listSecretProviderKinds()).toEqual(["protonpass"]);
  });
});

describe("attachments", () => {
  let attDb: DatabaseSync;
  let attOrc: CompanyOrchestrator;
  let attCompanyId: string;
  let tmpDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-attach-orc-"));
    attDb = createTestDb();
    attOrc = new CompanyOrchestrator(attDb, new Map(), tmpDir);
    attCompanyId = attOrc.seedCompany({ name: "Attach Co", slug: "attach", crew, departments });
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    attDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads, reads back, and lists a general attachment", async () => {
    const buffer = Buffer.from("hello ironcrew");
    const row = attOrc.uploadAttachment(attCompanyId, { filename: "notes.txt", buffer });
    expect(row.filename).toBe("notes.txt");
    expect(row.task_id).toBeNull();

    const read = attOrc.readAttachment(attCompanyId, row.id);
    expect(read?.buffer.toString("utf8")).toBe("hello ironcrew");
    expect(attOrc.attachments.listGeneral(attCompanyId).map((a) => a.id)).toEqual([row.id]);
  });

  it("readAttachment returns null for a cross-company id", () => {
    const other = attOrc.seedCompany({ name: "Other", slug: "other-att", crew, departments });
    const row = attOrc.uploadAttachment(other, { filename: "x", buffer: Buffer.from("x") });
    expect(attOrc.readAttachment(attCompanyId, row.id)).toBeNull();
  });

  it("deleteAttachment removes the row and, once orphaned, the blob from disk", async () => {
    const fs = await import("node:fs");
    const row = attOrc.uploadAttachment(attCompanyId, { filename: "x", buffer: Buffer.from("bytes") });
    const filePath = path.join(tmpDir, row.storage_key);
    expect(fs.existsSync(filePath)).toBe(true);

    expect(attOrc.deleteAttachment(attCompanyId, row.id)).toBe(true);
    expect(attOrc.attachments.get(row.id)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deleteAttachment keeps the blob on disk while a sibling row still shares it", async () => {
    const fs = await import("node:fs");
    const buffer = Buffer.from("shared bytes");
    const a = attOrc.uploadAttachment(attCompanyId, { filename: "a", buffer });
    const b = attOrc.uploadAttachment(attCompanyId, { filename: "b", buffer });
    expect(a.storage_key).toBe(b.storage_key);

    attOrc.deleteAttachment(attCompanyId, a.id);
    const filePath = path.join(tmpDir, a.storage_key);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(attOrc.readAttachment(attCompanyId, b.id)?.buffer.toString()).toBe("shared bytes");
  });

  it("deleteAttachment returns false for a missing or cross-company id", () => {
    expect(attOrc.deleteAttachment(attCompanyId, "att_nope")).toBe(false);
  });

  it("scopes an attachment to a real task", async () => {
    const task = attOrc.tasks.create({ companyId: attCompanyId, title: "Ship it" });
    const row = attOrc.uploadAttachment(attCompanyId, {
      filename: "spec.pdf",
      buffer: Buffer.from("spec"),
      taskId: task.id,
    });
    expect(attOrc.attachments.listForTask(attCompanyId, task.id).map((a) => a.id)).toEqual([row.id]);
  });
});

describe("Tailscale status", () => {
  it("tailscaleStatus/testTailscale dispatch to the registered provider", async () => {
    orc.registerTailscaleProvider({
      status: async () => ({ backendState: "Running", self: null, peers: [] }),
      testConnection: async () => ({ ok: true, message: "verbunden als crew-server" }),
    } as unknown as import("../network/tailscale-provider.ts").TailscaleProvider);

    const status = await orc.tailscaleStatus();
    expect(status.backendState).toBe("Running");
    const conn = await orc.testTailscale();
    expect(conn).toEqual({ ok: true, message: "verbunden als crew-server" });
  });

  it("without registration, lazily falls back to a real TailscaleProvider (reports not-ok when the CLI is absent)", async () => {
    const fresh = new CompanyOrchestrator(db);
    const status = await fresh.testTailscale();
    expect(status.ok).toBe(false);
  });
});

describe("remote workers over SSH-over-tailnet", () => {
  it("testRemoteWorker builds an SshConfig from the stored row and reports reachability", async () => {
    const captured: unknown[] = [];
    const fakeFactory = (config: unknown) => {
      captured.push(config);
      return { testConnection: async () => true } as unknown as ReturnType<
        typeof import("../../modules/workflow/ssh/ssh-connector.ts").createSshConnector
      >;
    };
    const workerOrc = new CompanyOrchestrator(db, new Map(), undefined, fakeFactory);
    const worker = workerOrc.remoteWorkers.create({
      companyId,
      label: "tier0-acme",
      environment: "customer:acme",
      host: "100.64.1.2",
      sshUser: "deploy",
      privateKeyPath: "/etc/ironcrew/keys/acme.pem",
    });

    const result = await workerOrc.testRemoteWorker(companyId, worker.id);
    expect(result).toEqual({ ok: true, message: "Erreichbar über 100.64.1.2:22" });
    expect(captured[0]).toEqual({
      host: "100.64.1.2",
      port: 22,
      user: "deploy",
      private_key_path: "/etc/ironcrew/keys/acme.pem",
      known_hosts_policy: "strict",
    });
  });

  it("testRemoteWorker reports not-ok when the SSH connector can't reach the host", async () => {
    const fakeFactory = () =>
      ({ testConnection: async () => false }) as unknown as ReturnType<
        typeof import("../../modules/workflow/ssh/ssh-connector.ts").createSshConnector
      >;
    const workerOrc = new CompanyOrchestrator(db, new Map(), undefined, fakeFactory);
    const worker = workerOrc.remoteWorkers.create({
      companyId,
      label: "tier0-acme",
      host: "100.64.1.2",
      sshUser: "deploy",
      privateKeyPath: "/etc/ironcrew/keys/acme.pem",
    });

    const result = await workerOrc.testRemoteWorker(companyId, worker.id);
    expect(result.ok).toBe(false);
  });

  it("testRemoteWorker reports not-ok for an unknown or cross-company worker id", async () => {
    const other = orc.seedCompany({ name: "Other", slug: "other-worker", crew, departments });
    const foreignWorker = orc.remoteWorkers.create({
      companyId: other,
      label: "w",
      host: "100.1.1.1",
      sshUser: "u",
      privateKeyPath: "/k",
    });

    expect((await orc.testRemoteWorker(companyId, "worker_nope")).ok).toBe(false);
    expect((await orc.testRemoteWorker(companyId, foreignWorker.id)).ok).toBe(false);
  });
});

describe("meetings — moderator, bounded rounds, budget", () => {
  function twoAgents(): [string, string] {
    const agents = orc.listAgents(companyId);
    return [agents[0].id, agents[1].id];
  }

  it("runs a turn against the registered runtime and records a real contribution + cost", async () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "Q3 Roadmap",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
      maxRounds: 3,
    });
    orc.meetings.start(meeting.id);

    const result = await orc.runMeetingTurn(companyId, meeting.id);
    expect(result?.turn.contribution).toBe("Analyse abgeschlossen.");
    expect(result?.turn.round).toBe(1);
    expect(result?.meeting.current_round).toBe(1);
    expect(result?.meeting.spent_micros).toBeGreaterThanOrEqual(0);
  });

  it("round-robins speakers across participants by default", async () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
      maxRounds: 4,
    });
    orc.meetings.start(meeting.id);

    const first = await orc.runMeetingTurn(companyId, meeting.id);
    const second = await orc.runMeetingTurn(companyId, meeting.id);
    expect(first?.turn.agent_id).not.toBe(second?.turn.agent_id);
  });

  it("lets the moderator pick an explicit speaker", async () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
    });
    orc.meetings.start(meeting.id);

    const result = await orc.runMeetingTurn(companyId, meeting.id, { agentId: participantId });
    expect(result?.turn.agent_id).toBe(participantId);
  });

  it("rejects an explicit speaker who isn't a participant", async () => {
    const [moderatorId, participantId] = twoAgents();
    const outsider = orc.listAgents(companyId)[2].id;
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
    });
    orc.meetings.start(meeting.id);

    await expect(orc.runMeetingTurn(companyId, meeting.id, { agentId: outsider })).rejects.toThrow();
  });

  it("self-closes the meeting the moment max_rounds is reached — bounded, not open-ended", async () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
      maxRounds: 2,
    });
    orc.meetings.start(meeting.id);

    await orc.runMeetingTurn(companyId, meeting.id);
    const second = await orc.runMeetingTurn(companyId, meeting.id);
    expect(second?.meeting.status).toBe("completed");

    // A third call must not run another turn — the meeting is over.
    const third = await orc.runMeetingTurn(companyId, meeting.id);
    expect(third).toBeNull();
    expect(orc.meetings.turns(meeting.id)).toHaveLength(2);
  });

  it("only ever sends a bounded recent-turns window as context, never the whole transcript", async () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
      maxRounds: 10,
    });
    orc.meetings.start(meeting.id);

    let lastPrompt = "";
    const capturingRuntime: AgentRuntime = {
      id: "capture",
      type: "capture",
      capabilities: async () => ({
        streaming: true,
        sessionResume: false,
        usageReporting: false,
        costReporting: false,
        toolCalls: false,
        subagents: false,
        defaultConcurrency: 1,
      }),
      healthCheck: async () => ({ healthy: true, installed: true, detail: "", checkedAt: Date.now() }),
      authStatus: async () => ({ authenticated: true, method: "none", detail: "" }),
      async *startRun(input: RunInput) {
        lastPrompt = input.prompt;
        yield {
          eventId: "e1",
          companyId,
          projectId: null,
          taskId: meeting.id,
          runId: "r1",
          agentId: null,
          seq: 0,
          type: "message.completed",
          timestamp: Date.now(),
          correlationId: "c1",
          payload: { text: "kurzer Beitrag" },
          redaction: { redacted: false, rules: [] },
        };
      },
      async cancelRun() {},
      async *resumeRun() {},
    };
    // Both agents share whatever runtime provider the seed crew gave them —
    // point that provider at the capturing fake for this test only.
    const agentRow = orc.listAgents(companyId)[0];
    orc.registerRuntime({ ...capturingRuntime, type: agentRow.runtime_provider });

    for (let i = 0; i < 9; i++) await orc.runMeetingTurn(companyId, meeting.id);

    // 9 prior turns exist, but the prompt only ever names a bounded window —
    // it must not contain a marker from a turn far outside that window.
    expect((lastPrompt.match(/kurzer Beitrag/g) ?? []).length).toBeLessThanOrEqual(6);
  });

  it("throws for a meeting that doesn't exist or isn't in_progress", async () => {
    const [moderatorId, participantId] = twoAgents();
    await expect(orc.runMeetingTurn(companyId, "mtg_nope")).rejects.toThrow();

    const scheduled = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
    });
    await expect(orc.runMeetingTurn(companyId, scheduled.id)).rejects.toThrow();
  });
});

describe("meeting action items become real tasks", () => {
  function twoAgents(): [string, string] {
    const agents = orc.listAgents(companyId);
    return [agents[0].id, agents[1].id];
  }

  it("converts an action item into a real, visible task", () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "Launch-Planung",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
    });
    const item = orc.meetings.addActionItem({
      meetingId: meeting.id,
      description: "Preisseite überarbeiten",
      assignedAgentId: participantId,
    });

    const task = orc.convertActionItemToTask(companyId, item.id);
    expect(task?.title).toBe("Preisseite überarbeiten");
    expect(task?.assigned_agent_id).toBe(participantId);
    expect(orc.tasks.get(task!.id)).not.toBeNull();

    const linked = orc.meetings.getActionItem(item.id);
    expect(linked?.task_id).toBe(task!.id);
  });

  it("is idempotent — converting twice returns the same task, not a duplicate", () => {
    const [moderatorId, participantId] = twoAgents();
    const meeting = orc.meetings.create({
      companyId,
      topic: "x",
      moderatorAgentId: moderatorId,
      participantAgentIds: [participantId],
    });
    const item = orc.meetings.addActionItem({ meetingId: meeting.id, description: "y" });

    const first = orc.convertActionItemToTask(companyId, item.id);
    const second = orc.convertActionItemToTask(companyId, item.id);
    expect(second?.id).toBe(first?.id);
  });

  it("returns null for a missing action item or a cross-company one", () => {
    expect(orc.convertActionItemToTask(companyId, "action_nope")).toBeNull();

    const other = orc.seedCompany({ name: "Other", slug: "other-mtg", crew, departments });
    const [otherModerator, otherParticipant] = [orc.listAgents(other)[0].id, orc.listAgents(other)[1].id];
    const foreignMeeting = orc.meetings.create({
      companyId: other,
      topic: "x",
      moderatorAgentId: otherModerator,
      participantAgentIds: [otherParticipant],
    });
    const foreignItem = orc.meetings.addActionItem({ meetingId: foreignMeeting.id, description: "z" });
    expect(orc.convertActionItemToTask(companyId, foreignItem.id)).toBeNull();
  });
});
