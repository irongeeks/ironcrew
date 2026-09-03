/**
 * IronCrew — company orchestrator.
 *
 * The vertical slice lives here:
 *
 *   CEO -> EA triage -> task -> delegation -> run -> review -> CEO summary
 *
 * Everything is persisted as it happens, so a restart mid-flow loses nothing;
 * the reconstruction path is exercised by the "survives a restart" test.
 */

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { newCorrelationId, newId } from "../domain/ids.ts";
import { TaskStore, type TaskRow } from "../domain/task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { appendAuditEvent, type ActorType } from "../domain/audit.ts";
import { canTransition, deriveAgentStatus, type TaskStatus } from "../domain/task-state.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { BudgetEngine } from "../policy/budget-engine.ts";
import { SandboxGrantStore } from "../domain/sandbox-grant-store.ts";
import { GoalStore } from "../domain/goal-store.ts";
import { ProjectStore } from "../domain/project-store.ts";
import { NotificationStore } from "../domain/notification-store.ts";
import { DecisionStore } from "../domain/decision-store.ts";
import { SecretStore } from "../domain/secret-store.ts";
import { AttachmentStore, type AttachmentRow } from "../domain/attachment-store.ts";
import { AttachmentStorage } from "../domain/attachment-storage.ts";
import type { ApprovalRow } from "../policy/approval-policy.ts";
import { SecretResolutionError, type SecretProvider } from "../secrets/secret-provider.ts";
import type { SecretProviderKind } from "../secrets/secret-ref.ts";
import { RemoteWorkerStore } from "../domain/remote-worker-store.ts";
import {
  TailscaleProvider,
  type TailscaleConnectionStatus,
  type TailscaleStatus,
} from "../network/tailscale-provider.ts";
import { createSshConnector, type SshConnectorInterface } from "../../modules/workflow/ssh/ssh-connector.ts";
import type { SshConfig } from "../../modules/workflow/ssh/types.ts";
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
  readonly goals: GoalStore;
  readonly projects: ProjectStore;
  readonly notifications: NotificationStore;
  readonly decisions: DecisionStore;
  readonly secrets: SecretStore;
  readonly attachments: AttachmentStore;
  readonly remoteWorkers: RemoteWorkerStore;
  private readonly secretProviders = new Map<SecretProviderKind, SecretProvider>();
  private attachmentStorageInstance: AttachmentStorage | null = null;
  private tailscaleProviderInstance: TailscaleProvider | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly runtimes: Map<string, AgentRuntime> = new Map(),
    // Not opened until first actually used (see the `attachmentStorage`
    // getter) — so every existing orchestrator test that never touches
    // attachments never creates this directory, and each attachment test
    // that does can still override it with an isolated temp dir.
    private readonly attachmentStorageRoot: string = path.resolve(process.cwd(), "data", "crew-attachments"),
    // Injectable so tests never spawn a real `ssh` process — see
    // testRemoteWorker() below.
    private readonly sshConnectorFactory: (config: SshConfig) => SshConnectorInterface = createSshConnector,
  ) {
    this.tasks = new TaskStore(db);
    this.runs = new RunStore(db);
    this.approvals = new ApprovalEngine(db);
    this.sandboxGrants = new SandboxGrantStore(db);
    this.budgets = new BudgetEngine(db);
    this.goals = new GoalStore(db);
    this.projects = new ProjectStore(db);
    this.notifications = new NotificationStore(db);
    this.decisions = new DecisionStore(db);
    this.secrets = new SecretStore(db);
    this.attachments = new AttachmentStore(db);
    this.remoteWorkers = new RemoteWorkerStore(db);
  }

  private get attachmentStorage(): AttachmentStorage {
    if (!this.attachmentStorageInstance) {
      this.attachmentStorageInstance = new AttachmentStorage(this.attachmentStorageRoot);
    }
    return this.attachmentStorageInstance;
  }

  /** Mirrors registerSecretProvider(): unregistered defaults to a real TailscaleProvider only once actually used. */
  registerTailscaleProvider(provider: TailscaleProvider): void {
    this.tailscaleProviderInstance = provider;
  }

  private get tailscaleProvider(): TailscaleProvider {
    if (!this.tailscaleProviderInstance) this.tailscaleProviderInstance = new TailscaleProvider();
    return this.tailscaleProviderInstance;
  }

  tailscaleStatus(): Promise<TailscaleStatus> {
    return this.tailscaleProvider.status();
  }

  testTailscale(): Promise<TailscaleConnectionStatus> {
    return this.tailscaleProvider.testConnection();
  }

  /**
   * SSH-over-tailnet reachability check for a registered remote worker.
   * Builds the same SshConfig shape server/modules/workflow/ssh/ssh-connector.ts
   * already expects, so a remote worker is exactly as safe (argv-array SSH,
   * ControlMaster reuse, allowlisted exec) as any other SSH target this
   * codebase talks to — nothing new was invented for this feature.
   */
  async testRemoteWorker(companyId: string, workerId: string): Promise<{ ok: boolean; message: string }> {
    const worker = this.remoteWorkers.get(workerId);
    if (!worker || worker.company_id !== companyId) {
      return { ok: false, message: `Remote worker "${workerId}" existiert nicht.` };
    }
    const config: SshConfig = {
      host: worker.host,
      port: worker.port,
      user: worker.ssh_user,
      private_key_path: worker.private_key_path,
      known_hosts_policy: worker.known_hosts_policy,
    };
    const reachable = await this.sshConnectorFactory(config).testConnection();
    return {
      ok: reachable,
      message: reachable
        ? `Erreichbar über ${worker.host}:${worker.port}`
        : `Nicht erreichbar über ${worker.host}:${worker.port}`,
    };
  }

  /**
   * The one place an approval turns into an inbox item. Both call sites that
   * create an approval (the sensitive-request path and a runtime's
   * approval.required event) go through this, so a notification can never
   * exist for an approval this didn't also mint the approval for.
   */
  private notifyApprovalRequested(companyId: string, approval: ApprovalRow): void {
    this.notifications.create({
      companyId,
      kind: "approval_required",
      severity: approval.risk_level === "critical" || approval.risk_level === "high" ? "critical" : "warning",
      title: approval.summary,
      body: approval.proposed_action,
      taskId: approval.task_id,
      approvalId: approval.id,
    });
  }

  /**
   * Decide a pending approval and, unlike calling `this.approvals.decide()`
   * directly, also leave a durable business record of it: a decision-log
   * entry (distinct from the audit chain — see decision-store.ts) and the
   * matching notification cleared from the inbox. Returns null exactly when
   * `approvals.decide()` would (already decided / does not exist).
   */
  decideApproval(
    companyId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    reason = "",
  ): ApprovalRow | null {
    const approval = this.approvals.decide(approvalId, decision, "ceo", reason);
    if (!approval) return null;

    this.decisions.create({
      companyId,
      title: approval.summary,
      decision,
      context: approval.impact,
      rationale: reason,
      decidedBy: "ceo",
      taskId: approval.task_id,
    });
    this.notifications.markReadByApproval(companyId, approval.id);

    return approval;
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type, runtime);
  }

  /** Mirrors registerRuntime(): wrapping is unconditional, health is reported truthfully by testConnection(). */
  registerSecretProvider(provider: SecretProvider): void {
    this.secretProviders.set(provider.kind, provider);
  }

  listSecretProviderKinds(): SecretProviderKind[] {
    return [...this.secretProviders.keys()];
  }

  async testSecretProvider(kind: SecretProviderKind): Promise<{ ok: boolean; message: string }> {
    const provider = this.secretProviders.get(kind);
    if (!provider) return { ok: false, message: `No "${kind}" provider is registered on this server.` };
    return provider.testConnection();
  }

  /**
   * Resolve a stored SecretRef to its live value. The value is returned to
   * the caller and never persisted here — not in the database, not in the
   * audit trail (whose `details` deliberately carry only the ref's
   * metadata), matching this store's own doc-comment
   * (domain/secret-store.ts) and docs/THREAT_MODEL.md.
   */
  async resolveSecret(
    companyId: string,
    secretId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): Promise<string> {
    const secret = this.secrets.get(secretId);
    if (!secret || secret.company_id !== companyId) {
      throw new SecretResolutionError(`Secret "${secretId}" does not exist.`);
    }
    const provider = this.secretProviders.get(secret.provider);
    if (!provider) {
      throw new SecretResolutionError(`No "${secret.provider}" provider is registered on this server.`);
    }

    const actorType = opts.actorType ?? "system";
    const actorId = opts.actorId ?? "orchestrator";
    try {
      const value = await provider.resolve({
        provider: secret.provider,
        itemRef: secret.item_ref,
        field: secret.field ?? undefined,
      });
      appendAuditEvent(this.db, {
        companyId,
        actorType,
        actorId,
        action: "secret.resolved",
        entityType: "secret",
        entityId: secret.id,
        outcome: "ok",
        details: { name: secret.name, provider: secret.provider },
      });
      return value;
    } catch (err) {
      appendAuditEvent(this.db, {
        companyId,
        actorType,
        actorId,
        action: "secret.resolved",
        entityType: "secret",
        entityId: secret.id,
        outcome: "failed",
        details: {
          name: secret.name,
          provider: secret.provider,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Write the blob to disk, then record it. Validation (task/project exist,
   * same company, at most one scope) happens inside attachments.create() —
   * writing first means a rejected upload can leave an unreferenced blob on
   * disk, but content-addressing makes that at most a few harmless stray
   * bytes, never a correctness or security issue, and never duplicated
   * across two calls the way validating twice would be.
   */
  uploadAttachment(
    companyId: string,
    input: {
      filename: string;
      contentType?: string;
      buffer: Buffer;
      taskId?: string | null;
      projectId?: string | null;
      uploadedBy?: string;
      actorType?: ActorType;
      actorId?: string;
    },
  ): AttachmentRow {
    const blob = this.attachmentStorage.write(companyId, input.buffer);
    return this.attachments.create({
      companyId,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      storageKey: blob.storageKey,
      sha256: blob.sha256,
      uploadedBy: input.uploadedBy,
      actorType: input.actorType,
      actorId: input.actorId,
    });
  }

  readAttachment(companyId: string, attachmentId: string): { row: AttachmentRow; buffer: Buffer } | null {
    const row = this.attachments.get(attachmentId);
    if (!row || row.company_id !== companyId) return null;
    return { row, buffer: this.attachmentStorage.read(row.storage_key) };
  }

  /**
   * Deletes the row, then the blob too — but only once no other row (the
   * content-addressed store can be shared, see attachment-storage.ts)
   * references it any more.
   */
  deleteAttachment(
    companyId: string,
    attachmentId: string,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): boolean {
    const existing = this.attachments.get(attachmentId);
    if (!existing || existing.company_id !== companyId) return false;
    const deleted = this.attachments.delete(attachmentId, opts);
    if (!deleted) return false;
    if (this.attachments.isStorageKeyOrphaned(deleted.storage_key)) {
      this.attachmentStorage.delete(deleted.storage_key);
    }
    return true;
  }

  // --- seeding ------------------------------------------------------------

  /**
   * Create the company, departments and seed crew. Idempotent: running it
   * again on an existing company leaves the data alone.
   */
  seedCompany(input: { name: string; slug: string; crew?: CrewConfig; departments?: DepartmentConfig }): string {
    const existing = this.db.prepare("SELECT id FROM crew_companies WHERE slug = ?").get(input.slug) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;

    const crew = input.crew ?? loadCrewConfig();
    const departments = input.departments ?? loadDepartmentConfig();

    const companyId = newId("cmp");
    this.db
      .prepare("INSERT INTO crew_companies (id, name, slug) VALUES (?,?,?)")
      .run(companyId, input.name, input.slug);

    const deptIds = new Map<string, string>();
    for (const d of departments.departments) {
      const id = newId("dept");
      this.db
        .prepare(
          "INSERT INTO crew_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)",
        )
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
        `INSERT INTO crew_agents
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
      .prepare("SELECT * FROM crew_agents WHERE company_id = ? ORDER BY key")
      .all(companyId) as unknown as AgentRow[];
  }

  getAgent(companyId: string, key: string): AgentRow | null {
    return (
      (this.db.prepare("SELECT * FROM crew_agents WHERE company_id = ? AND key = ?").get(companyId, key) as
        | AgentRow
        | undefined) ?? null
    );
  }

  executiveAssistant(companyId: string): AgentRow {
    const ea = this.db
      .prepare("SELECT * FROM crew_agents WHERE company_id = ? AND is_executive_assistant = 1")
      .get(companyId) as AgentRow | undefined;
    if (!ea) throw new Error("No executive assistant is configured for this company.");
    return ea;
  }

  /** Every runtime registered with this orchestrator, mock and real alike. */
  listRuntimes(): AgentRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Change which registered runtime provider an agent's tasks execute
   * against. Returns null when the agent does not exist in this company —
   * callers translate that to a 404 rather than a validation error, since
   * the provider itself is validated separately (against listRuntimes())
   * before this is ever called.
   */
  setAgentRuntimeProvider(companyId: string, agentId: string, provider: string): AgentRow | null {
    const agent = this.db
      .prepare("SELECT * FROM crew_agents WHERE id = ? AND company_id = ?")
      .get(agentId, companyId) as AgentRow | undefined;
    if (!agent) return null;
    if (!this.runtimes.has(provider)) {
      throw new Error(`Unknown runtime provider "${provider}". Registered: ${[...this.runtimes.keys()].join(", ")}`);
    }
    this.db.prepare("UPDATE crew_agents SET runtime_provider = ? WHERE id = ?").run(provider, agentId);
    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId: "ceo",
      action: "agent.runtime_changed",
      entityType: "agent",
      entityId: agentId,
      details: { from: agent.runtime_provider, to: provider },
    });
    return { ...agent, runtime_provider: provider };
  }

  /**
   * Agent status derived from held work — never self-reported, so the UI
   * figure cannot disagree with the backend.
   */
  agentStatus(companyId: string, agentId: string): string {
    const rows = this.db
      .prepare("SELECT status FROM crew_tasks WHERE company_id = ? AND assigned_agent_id = ?")
      .all(companyId, agentId) as unknown as Array<{ status: TaskStatus }>;
    const agent = this.db.prepare("SELECT status FROM crew_agents WHERE id = ?").get(agentId) as
      | { status: string }
      | undefined;
    const lastRun = this.db
      .prepare("SELECT status FROM crew_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
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
        .prepare("UPDATE crew_agents SET status = ?, updated_at = ? WHERE id = ?")
        .run(derived, Date.now(), agent.id);
    }
  }

  // --- conversation -------------------------------------------------------

  ensureCeoConversation(companyId: string): string {
    const existing = this.db
      .prepare("SELECT id FROM crew_conversations WHERE company_id = ? AND kind = 'ceo_ea' LIMIT 1")
      .get(companyId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = newId("conv");
    this.db
      .prepare("INSERT INTO crew_conversations (id, company_id, kind, title) VALUES (?,?, 'ceo_ea', ?)")
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
        `INSERT INTO crew_messages
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
      .prepare("SELECT * FROM crew_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?")
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
      this.notifyApprovalRequested(companyId, approval);
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
          `SELECT a.* FROM crew_agents a
             JOIN crew_departments d ON d.id = a.department_id
            WHERE a.company_id = ? AND d.key = ? AND a.is_executive_assistant = 0
            ORDER BY a.key LIMIT 1`,
        )
        .get(companyId, result.suggestedDepartment) as AgentRow | undefined;
      if (row) return row;
    }
    return this.getAgent(companyId, "coo") ?? null;
  }

  /**
   * "Goals and goal ancestry in the context builder" (docs/ROADMAP.md Phase
   * 2): when a task's project traces up to a strategic goal, tell the agent
   * why the work matters, not only what to do. Returns "" — never a
   * fabricated block — when the task has no project, the project has no
   * goal, or the goal chain cannot be resolved, so a run's prompt never
   * claims strategic context that does not actually exist.
   */
  private buildStrategicContext(projectId: string | null): string {
    if (!projectId) return "";
    const project = this.projects.get(projectId);
    if (!project?.goal_id) return "";
    const chain = this.goals.ancestry(project.goal_id);
    if (chain.length === 0) return "";
    return `\n\n# Strategischer Kontext\nDieser Auftrag dient dem Projekt "${project.title}", das folgendem Ziel folgt:\n${chain.map((g) => g.title).join(" -> ")}`;
  }

  buildStatusSummary(companyId: string): string {
    const counts = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM crew_tasks WHERE company_id = ? GROUP BY status")
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

    const agent = this.db.prepare("SELECT * FROM crew_agents WHERE id = ?").get(agentId) as AgentRow | undefined;
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

    const strategicContext = this.buildStrategicContext(candidate.project_id);

    const events: RunEvent[] = [];
    let failed = false;
    let waiting = false;
    let summary = "";

    try {
      for await (const ev of runtime.startRun(
        { prompt: `${seedAgentGuidance}${strategicContext}\n\n# Aufgabe\n${candidate.description}` },
        {
          companyId,
          projectId: candidate.project_id,
          taskId: candidate.id,
          runId: run.id,
          agentId,
          correlationId: candidate.correlation_id,
          workspacePath: opts.workspacePath ?? "/tmp/iron-crew-workspace",
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
          const approval = this.approvals.request(
            companyId,
            {
              approvalType: p.approvalType ?? "irreversible_data_change",
              requestedBy: agentId,
              summary: p.summary ?? "Agent requested approval",
              riskLevel: (p.riskLevel as "high") ?? "high",
            },
            { taskId: candidate.id, runId: run.id, correlationId: candidate.correlation_id },
          );
          this.notifyApprovalRequested(companyId, approval);
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
