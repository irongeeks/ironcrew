/**
 * Iron Command OS — company orchestrator.
 *
 * The vertical slice lives here:
 *
 *   CEO -> EA triage -> task -> delegation -> run -> review -> CEO summary
 *
 * Everything is persisted as it happens, so a restart mid-flow loses nothing;
 * the reconstruction path is exercised by the "survives a restart" test.
 */

import type { DatabaseSync } from "node:sqlite";
import { newCorrelationId, newId } from "../domain/ids.ts";
import { TaskStore, type TaskRow } from "../domain/task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { appendAuditEvent } from "../domain/audit.ts";
import { canTransition, deriveAgentStatus, type TaskStatus } from "../domain/task-state.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { BudgetEngine } from "../policy/budget-engine.ts";
import { SandboxGrantStore } from "../domain/sandbox-grant-store.ts";
import { resolvePermissionMode } from "../policy/runtime-permissions.ts";
import { mayDelegateAutonomously, normaliseGerman, triage, type TriageResult } from "./triage.ts";
import {
  buildAgentGuidance,
  loadCrewConfig,
  loadDepartmentConfig,
  type CrewConfig,
  type DepartmentConfig,
  type SeedAgent,
} from "../domain/crew-config.ts";
import type { AgentRuntime, RunEvent } from "../runtime/run-events.ts";

export interface AgentRow {
  id: string;
  company_id: string;
  department_id: string | null;
  key: string;
  professional_role: string;
  role_summary: string;
  seniority: string;
  policy_json: string;
  persona_json: string;
  display_name: string;
  runtime_profile: string;
  runtime_provider: string;
  status: string;
  status_detail: string;
  is_executive_assistant: number;
}

export interface CeoMessageResult {
  conversationId: string;
  messageId: string;
  triage: TriageResult;
  /** Task created for this message, when one was warranted. */
  task: TaskRow | null;
  /** Agent the task was delegated to, when delegation happened. */
  assignedAgent: AgentRow | null;
  /** The EA's reply to the CEO. */
  reply: string;
  correlationId: string;
}

export class CompanyOrchestrator {
  readonly tasks: TaskStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalEngine;
  readonly budgets: BudgetEngine;
  readonly sandboxGrants: SandboxGrantStore;

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtimes: Map<string, AgentRuntime> = new Map(),
  ) {
    this.tasks = new TaskStore(db);
    this.runs = new RunStore(db);
    this.approvals = new ApprovalEngine(db);
    this.sandboxGrants = new SandboxGrantStore(db);
    this.budgets = new BudgetEngine(db);
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type, runtime);
  }

  // --- seeding ------------------------------------------------------------

  /**
   * Create the company, departments and seed crew. Idempotent: running it
   * again on an existing company leaves the data alone.
   */
  seedCompany(input: { name: string; slug: string; crew?: CrewConfig; departments?: DepartmentConfig }): string {
    const existing = this.db.prepare("SELECT id FROM ic_companies WHERE slug = ?").get(input.slug) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;

    const crew = input.crew ?? loadCrewConfig();
    const departments = input.departments ?? loadDepartmentConfig();

    const companyId = newId("cmp");
    this.db.prepare("INSERT INTO ic_companies (id, name, slug) VALUES (?,?,?)").run(companyId, input.name, input.slug);

    const deptIds = new Map<string, string>();
    for (const d of departments.departments) {
      const id = newId("dept");
      this.db
        .prepare("INSERT INTO ic_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)")
        .run(id, companyId, d.key, d.name, d.description, d.sort_order);
      deptIds.set(d.key, id);
    }

    for (const agent of crew.agents) {
      this.insertAgent(companyId, agent, deptIds.get(agent.department) ?? null);
    }

    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "bootstrap",
      action: "company.seeded",
      entityType: "company",
      entityId: companyId,
      details: {
        name: input.name,
        departments: departments.departments.length,
        agents: crew.agents.length,
      },
    });

    return companyId;
  }

  private insertAgent(companyId: string, agent: SeedAgent, departmentId: string | null): string {
    const id = newId("agt");
    this.db
      .prepare(
        `INSERT INTO ic_agents
           (id, company_id, department_id, key, professional_role, role_summary, seniority,
            policy_json, persona_json, display_name, runtime_profile, runtime_provider,
            status, is_executive_assistant)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'idle',?)`,
      )
      .run(
        id,
        companyId,
        departmentId,
        agent.key,
        agent.professional_role,
        agent.role_summary,
        agent.seniority,
        JSON.stringify(agent.policy),
        JSON.stringify(agent.skin),
        agent.skin.display_name,
        agent.runtime_profile,
        "mock",
        agent.is_executive_assistant ? 1 : 0,
      );
    return id;
  }

  // --- reads --------------------------------------------------------------

  listAgents(companyId: string): AgentRow[] {
    return this.db
      .prepare("SELECT * FROM ic_agents WHERE company_id = ? ORDER BY key")
      .all(companyId) as unknown as AgentRow[];
  }

  getAgent(companyId: string, key: string): AgentRow | null {
    return (
      (this.db.prepare("SELECT * FROM ic_agents WHERE company_id = ? AND key = ?").get(companyId, key) as
        | AgentRow
        | undefined) ?? null
    );
  }

  executiveAssistant(companyId: string): AgentRow {
    const ea = this.db
      .prepare("SELECT * FROM ic_agents WHERE company_id = ? AND is_executive_assistant = 1")
      .get(companyId) as AgentRow | undefined;
    if (!ea) throw new Error("No executive assistant is configured for this company.");
    return ea;
  }

  /**
   * Agent status derived from held work — never self-reported, so the UI
   * figure cannot disagree with the backend.
   */
  agentStatus(companyId: string, agentId: string): string {
    const rows = this.db
      .prepare("SELECT status FROM ic_tasks WHERE company_id = ? AND assigned_agent_id = ?")
      .all(companyId, agentId) as unknown as Array<{ status: TaskStatus }>;
    const agent = this.db.prepare("SELECT status FROM ic_agents WHERE id = ?").get(agentId) as
      | { status: string }
      | undefined;
    const lastRun = this.db
      .prepare("SELECT status FROM ic_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(agentId) as { status: string } | undefined;

    return deriveAgentStatus({
      online: agent?.status !== "offline",
      paused: agent?.status === "paused",
      rateLimited: agent?.status === "rate_limited" || lastRun?.status === "rate_limited",
      taskStatuses: rows.map((r) => r.status),
      lastRunFailed: lastRun?.status === "failed",
    });
  }

  /** Refresh the persisted agent status from derived state. */
  syncAgentStatuses(companyId: string): void {
    for (const agent of this.listAgents(companyId)) {
      if (agent.status === "paused" || agent.status === "offline") continue;
      const derived = this.agentStatus(companyId, agent.id);
      this.db
        .prepare("UPDATE ic_agents SET status = ?, updated_at = ? WHERE id = ?")
        .run(derived, Date.now(), agent.id);
    }
  }

  // --- conversation -------------------------------------------------------

  ensureCeoConversation(companyId: string): string {
    const existing = this.db
      .prepare("SELECT id FROM ic_conversations WHERE company_id = ? AND kind = 'ceo_ea' LIMIT 1")
      .get(companyId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = newId("conv");
    this.db
      .prepare("INSERT INTO ic_conversations (id, company_id, kind, title) VALUES (?,?, 'ceo_ea', ?)")
      .run(id, companyId, "CEO & Executive Assistant");
    return id;
  }

  private addMessage(input: {
    companyId: string;
    conversationId: string;
    role: "ceo" | "agent" | "system";
    body: string;
    authorAgentId?: string | null;
    taskId?: string | null;
    triage?: TriageResult | null;
    correlationId: string;
  }): string {
    const id = newId("msg");
    this.db
      .prepare(
        `INSERT INTO ic_messages
           (id, company_id, conversation_id, role, author_agent_id, body, task_id, triage_json, correlation_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.conversationId,
        input.role,
        input.authorAgentId ?? null,
        input.body,
        input.taskId ?? null,
        input.triage ? JSON.stringify(input.triage) : null,
        input.correlationId,
      );
    return id;
  }

  listMessages(conversationId: string, limit = 200): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM ic_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(conversationId, limit) as unknown as Array<Record<string, unknown>>;
  }

  // --- the main flow ------------------------------------------------------

  /**
   * Handle a message from the CEO: triage it, and where warranted create a
   * task and delegate it.
   *
   * The EA never approves anything and never executes a sensitive action
   * itself — it raises an approval request and reports back.
   */
  handleCeoMessage(companyId: string, body: string): CeoMessageResult {
    const correlationId = newCorrelationId();
    const conversationId = this.ensureCeoConversation(companyId);
    const ea = this.executiveAssistant(companyId);

    const result = triage(body);
    const messageId = this.addMessage({
      companyId,
      conversationId,
      role: "ceo",
      body,
      triage: result,
      correlationId,
    });

    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId: "ceo",
      action: "ceo.message_received",
      entityType: "message",
      entityId: messageId,
      correlationId,
      details: { category: result.category, confidence: result.confidence, sensitive: result.sensitive },
    });

    // Weak signal: ask rather than guess.
    if (result.needsClarification) {
      const reply =
        "Ich habe die Nachricht erhalten, kann sie aber nicht eindeutig einordnen. " +
        "Soll ich daraus eine Aufgabe machen, oder ist es eine Frage zur direkten Beantwortung?";
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        triage: result,
        correlationId,
      });
      return { conversationId, messageId, triage: result, task: null, assignedAgent: null, reply, correlationId };
    }

    // Status requests are answered from state, not by starting work.
    if (result.category === "status_request") {
      const reply = this.buildStatusSummary(companyId);
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        triage: result,
        correlationId,
      });
      return { conversationId, messageId, triage: result, task: null, assignedAgent: null, reply, correlationId };
    }

    // Create the task.
    const task = this.tasks.create({
      companyId,
      title: body.split("\n")[0].slice(0, 120),
      description: body,
      status: "ready",
      priority: result.category === "incident" ? "urgent" : "normal",
      riskLevel: result.riskLevel,
      sensitive: result.sensitive,
      createdBy: "owner",
      correlationId,
    });

    // Sensitive work is parked behind an approval before anyone touches it.
    if (result.sensitive) {
      const approval = this.approvals.request(
        companyId,
        {
          approvalType: this.approvalTypeFor(body),
          requestedBy: ea.id,
          summary: `Freigabe erforderlich für: ${task.title}`,
          riskLevel: "high",
          impact: "Sensible Aktion mit rechtlicher oder finanzieller Wirkung.",
          proposedAction: body,
        },
        { taskId: task.id, correlationId },
      );
      this.tasks.transition(task.id, "approval_required", {
        reason: "sensitive request awaiting owner approval",
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });

      const reply =
        `Das ist eine freigabepflichtige Aktion. Ich habe sie NICHT ausgeführt.\n` +
        `Freigabeanfrage ${approval.id} liegt in Ihrer Decision Inbox.`;
      this.addMessage({
        companyId,
        conversationId,
        role: "agent",
        authorAgentId: ea.id,
        body: reply,
        taskId: task.id,
        triage: result,
        correlationId,
      });
      return {
        conversationId,
        messageId,
        triage: result,
        task: this.tasks.get(task.id),
        assignedAgent: null,
        reply,
        correlationId,
      };
    }

    // Delegate.
    const agent = this.pickAgent(companyId, result);
    let assigned: AgentRow | null = null;
    let reply: string;

    if (agent && mayDelegateAutonomously(result)) {
      assigned = agent;
      reply =
        `Verstanden. Ich habe die Aufgabe "${task.title}" angelegt und an ` +
        `${agent.display_name} (${agent.professional_role}) delegiert. ` +
        `Sie erhalten das Ergebnis zur Abnahme.`;
    } else if (agent) {
      assigned = agent;
      reply =
        `Verstanden. Ich habe die Aufgabe "${task.title}" angelegt und ${agent.display_name} ` +
        `zugewiesen. Umfang und Vorgehen lege ich Ihnen vor der Ausführung vor.`;
    } else {
      reply =
        `Aufgabe "${task.title}" ist angelegt, aber ich habe noch keinen passenden ` +
        `Verantwortlichen gefunden. Bitte weisen Sie sie zu.`;
    }

    if (assigned) {
      this.tasks.transition(task.id, "assigned", {
        assignedAgentId: assigned.id,
        reason: `delegated by executive assistant (${result.category})`,
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });
      // Return the task to ready so the scheduler's atomic claim owns the
      // assignment decision; delegation records intent, claiming grants it.
      this.tasks.transition(task.id, "ready", {
        reason: "queued for execution",
        actorType: "agent",
        actorId: ea.id,
        correlationId,
      });
    }

    this.addMessage({
      companyId,
      conversationId,
      role: "agent",
      authorAgentId: ea.id,
      body: reply,
      taskId: task.id,
      triage: result,
      correlationId,
    });

    return {
      conversationId,
      messageId,
      triage: result,
      task: this.tasks.get(task.id),
      assignedAgent: assigned,
      reply,
      correlationId,
    };
  }

  /**
   * Map a sensitive request to the approval type that gates it.
   *
   * Matching runs on normalised text and on word STARTS only: a trailing \b
   * would reject the inflected forms people actually write ("überweise"),
   * and \b before an umlaut never matches at all.
   */
  private approvalTypeFor(body: string): string {
    const t = normaliseGerman(body);
    const has = (...list: string[]) => list.some((stem) => new RegExp(`(?:^|[^a-z0-9])${stem}`, "i").test(t));

    if (has("ueberweis", "zahlung", "transfer", "iban", "lastschrift", "bezahl")) return "bank_transfer";
    if (has("ustva", "umsatzsteuer", "steuererklaerung", "elster", "finanzamt")) return "tax_filing";
    if (has("vertrag", "nda", "kuendig", "unterschreib", "unterzeichn")) return "contract_execution";
    if (has("produktiv", "production", "live schalten")) return "production_deployment";
    if (has("passwort", "password", "api-key", "api key", "zugangsdaten", "secret")) return "secret_disclosure";
    return "irreversible_data_change";
  }

  /** Choose an agent by department hint, falling back to the COO. */
  private pickAgent(companyId: string, result: TriageResult): AgentRow | null {
    if (result.suggestedDepartment) {
      const row = this.db
        .prepare(
          `SELECT a.* FROM ic_agents a
             JOIN ic_departments d ON d.id = a.department_id
            WHERE a.company_id = ? AND d.key = ? AND a.is_executive_assistant = 0
            ORDER BY a.key LIMIT 1`,
        )
        .get(companyId, result.suggestedDepartment) as AgentRow | undefined;
      if (row) return row;
    }
    return this.getAgent(companyId, "coo") ?? null;
  }

  buildStatusSummary(companyId: string): string {
    const counts = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM ic_tasks WHERE company_id = ? GROUP BY status")
      .all(companyId) as unknown as Array<{ status: string; n: number }>;
    const pending = this.approvals.listPending(companyId).length;

    const parts = counts.length ? counts.map((c) => `${c.n}× ${c.status}`).join(", ") : "keine Aufgaben erfasst";
    return `Aktueller Stand: ${parts}. Offene Freigaben: ${pending}.`;
  }

  // --- execution ----------------------------------------------------------

  /**
   * Claim and execute one ready task with the given runtime.
   *
   * Returns null when nothing was claimable or another worker won the race.
   * The budget gate runs before the claim, so a blocked company does not
   * churn task state.
   */
  async executeNextTask(
    companyId: string,
    opts: { runtimeType?: string; workspacePath?: string; onEvent?: (e: RunEvent) => void } = {},
  ): Promise<{ task: TaskRow; runId: string; events: RunEvent[] } | null> {
    const claimable = this.tasks.findClaimable(companyId);
    if (claimable.length === 0) return null;

    const candidate = claimable[0];
    const agentId = candidate.assigned_agent_id;
    if (!agentId) return null;

    const agent = this.db.prepare("SELECT * FROM ic_agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    if (!agent) return null;

    const runtimeType = opts.runtimeType ?? agent.runtime_provider;
    const runtime = this.runtimes.get(runtimeType);
    if (!runtime) throw new Error(`No runtime registered for type "${runtimeType}".`);

    // Pre-dispatch budget gate.
    this.budgets.assertRunPermitted(companyId, {
      agentId,
      projectId: candidate.project_id,
      taskId: candidate.id,
      runtimeType,
    });

    // Elevation is reachable only through a live grant minted from an
    // approved sandbox_elevation approval (SandboxGrantStore). Its mere
    // presence is what the orchestrator "asks" resolvePermissionMode() for —
    // the resolver re-validates company/runtime/task scope and expiry itself
    // and fails closed to "restricted" on any mismatch, so this lookup is a
    // narrowing convenience, never the authority.
    const grant = this.sandboxGrants.findLive({
      companyId,
      provider: runtimeType,
      taskId: candidate.id,
    });
    const permission = resolvePermissionMode({
      provider: runtimeType,
      companyId,
      taskId: candidate.id,
      requested: grant ? "elevated" : "restricted",
      grant,
    });
    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "permission-resolver",
      action: "permission.resolved",
      entityType: "task",
      entityId: candidate.id,
      taskId: candidate.id,
      correlationId: candidate.correlation_id,
      details: { mode: permission.mode, code: permission.code, grantId: permission.grantId ?? null },
    });

    const run = this.runs.create({
      companyId,
      taskId: candidate.id,
      agentId,
      projectId: candidate.project_id,
      runtimeType,
      permissionMode: permission.mode,
      sandboxGrantId: permission.grantId ?? null,
      correlationId: candidate.correlation_id,
    });

    const claimed = this.tasks.claim({
      taskId: candidate.id,
      runId: run.id,
      agentId,
      expectedVersion: candidate.status_version,
      correlationId: candidate.correlation_id,
    });
    if (!claimed) {
      this.runs.setStatus(run.id, "cancelled");
      return null;
    }

    this.tasks.transition(claimed.id, "running", {
      reason: "run started",
      actorType: "agent",
      actorId: agentId,
      correlationId: claimed.correlation_id,
    });

    const seedAgentGuidance = buildAgentGuidance({
      key: agent.key,
      department: "",
      professional_role: agent.professional_role,
      role_summary: agent.role_summary,
      seniority: agent.seniority,
      is_executive_assistant: agent.is_executive_assistant === 1,
      runtime_profile: agent.runtime_profile,
      skin: JSON.parse(agent.persona_json),
      policy: JSON.parse(agent.policy_json),
    });

    const events: RunEvent[] = [];
    let failed = false;
    let waiting = false;
    let summary = "";

    try {
      for await (const ev of runtime.startRun(
        { prompt: `${seedAgentGuidance}\n\n# Aufgabe\n${candidate.description}` },
        {
          companyId,
          projectId: candidate.project_id,
          taskId: candidate.id,
          runId: run.id,
          agentId,
          correlationId: candidate.correlation_id,
          workspacePath: opts.workspacePath ?? "/tmp/iron-command-workspace",
          permissionMode: permission.mode,
        },
      )) {
        const persisted = this.runs.appendEvent({
          companyId,
          runId: run.id,
          taskId: candidate.id,
          projectId: candidate.project_id,
          agentId,
          type: ev.type,
          payload: ev.payload,
          correlationId: ev.correlationId,
        });
        events.push(persisted);
        opts.onEvent?.(persisted);

        this.runs.heartbeat(run.id);

        if (ev.type === "usage.updated") {
          const p = ev.payload as { inputTokens?: number; outputTokens?: number; costMicros?: number };
          this.runs.addUsage(run.id, p.inputTokens ?? 0, p.outputTokens ?? 0, p.costMicros ?? 0);
          this.budgets.recordCost({
            companyId,
            runId: run.id,
            taskId: candidate.id,
            projectId: candidate.project_id,
            agentId,
            runtimeType,
            // A subscription runtime reports no price; record it as quota.
            kind: (p.costMicros ?? 0) > 0 ? "usage" : "quota",
            inputTokens: p.inputTokens ?? 0,
            outputTokens: p.outputTokens ?? 0,
            costMicros: p.costMicros ?? 0,
          });
        }

        if (ev.type === "message.completed") summary = String((ev.payload as { text?: string }).text ?? "");
        if (ev.type === "run.failed") failed = true;
        if (ev.type === "run.cancelled") failed = true;
        if (ev.type === "run.waiting") waiting = true;
        if (ev.type === "approval.required") {
          const p = ev.payload as { approvalType?: string; summary?: string; riskLevel?: string };
          this.approvals.request(
            companyId,
            {
              approvalType: p.approvalType ?? "irreversible_data_change",
              requestedBy: agentId,
              summary: p.summary ?? "Agent requested approval",
              riskLevel: (p.riskLevel as "high") ?? "high",
            },
            { taskId: candidate.id, runId: run.id, correlationId: candidate.correlation_id },
          );
        }
      }
    } catch (err) {
      this.runs.appendEvent({
        companyId,
        runId: run.id,
        taskId: candidate.id,
        agentId,
        type: "run.failed",
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
      failed = true;
    }

    this.tasks.releaseLock(candidate.id, run.id);

    const current = this.tasks.get(candidate.id)!;
    const target: TaskStatus = failed ? "failed" : waiting ? "waiting" : "review";
    this.tasks.transition(candidate.id, target, {
      expectedVersion: current.status_version,
      reason: `run ${run.id} finished`,
      actorType: "agent",
      actorId: agentId,
      resultSummary: summary || null,
      correlationId: candidate.correlation_id,
    });

    this.syncAgentStatuses(companyId);
    return { task: this.tasks.get(candidate.id)!, runId: run.id, events };
  }

  /**
   * CEO accepts a result in review. The EA records the outcome and the task
   * is done.
   */
  acceptReview(companyId: string, taskId: string, note = ""): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // A CEO action that does not apply right now is a "no", not a crash:
    // return null so the API answers 409 rather than surfacing a store error.
    if (!canTransition(task.status, "done")) return null;

    const done = this.tasks.transition(taskId, "done", {
      reason: "accepted by CEO",
      actorType: "owner",
      actorId: "ceo",
      reviewNotes: note || null,
      correlationId: task.correlation_id,
    });
    if (!done) return null;

    this.addMessage({
      companyId,
      conversationId: this.ensureCeoConversation(companyId),
      role: "agent",
      authorAgentId: ea.id,
      body: `Abgenommen: "${task.title}". ${task.result_summary ?? ""}`.trim(),
      taskId,
      correlationId: task.correlation_id,
    });
    this.syncAgentStatuses(companyId);
    return done;
  }

  /** CEO requests a revision: the task goes back to ready for another attempt. */
  requestRevision(companyId: string, taskId: string, reason: string): TaskRow | null {
    const ea = this.executiveAssistant(companyId);
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!canTransition(task.status, "ready")) return null;

    const revised = this.tasks.transition(taskId, "ready", {
      reason: `revision requested: ${reason}`,
      actorType: "owner",
      actorId: "ceo",
      reviewNotes: reason,
      correlationId: task.correlation_id,
    });
    if (!revised) return null;

    this.addMessage({
      companyId,
      conversationId: this.ensureCeoConversation(companyId),
      role: "agent",
      authorAgentId: ea.id,
      body: `Revision angenommen für "${task.title}". Grund: ${reason}. Ich lasse überarbeiten.`,
      taskId,
      correlationId: task.correlation_id,
    });
    this.syncAgentStatuses(companyId);
    return revised;
  }

  /** Recover tasks whose worker died, so nothing is silently stuck. */
  recoverOrphanedTasks(companyId: string, now = Date.now()): TaskRow[] {
    const recovered: TaskRow[] = [];
    for (const task of this.tasks.findOrphaned(companyId, now)) {
      if (!task.execution_run_id) continue;
      const r = this.tasks.recoverOrphaned(task.id, task.execution_run_id);
      if (r) {
        this.runs.setStatus(task.execution_run_id, "failed", { errorMessage: "worker lost; run orphaned" });
        recovered.push(r);
      }
    }
    return recovered;
  }
}
