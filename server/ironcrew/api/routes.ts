/**
 * IronCrew — REST surface.
 *
 * Deliberately self-contained: it takes an Express app, a database handle and
 * a broadcast function, and nothing else. It does not reach into the upstream
 * runtime god-object, so it can be tested headlessly and mounted independently.
 *
 * Every request body is Zod-validated at the boundary. Every write goes
 * through the domain layer, so state-machine validation, atomic claiming,
 * budget gates and audit logging cannot be bypassed by calling the API
 * directly — the same guarantees the UI gets.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CompanyOrchestrator, type AgentRow } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { listAuditEvents, verifyAuditChain } from "../domain/audit.ts";
import { getVendorPolicy, evaluateModel, filterModelCatalogue } from "../policy/vendor-policy.ts";
import { ApprovalRequiredError } from "../policy/approval-policy.ts";
import { BudgetExceededError } from "../policy/budget-engine.ts";
import { InvalidTransitionError, TASK_STATUSES } from "../domain/task-state.ts";
import { TaskDependencyError } from "../domain/task-store.ts";
import { GoalMutationError } from "../domain/goal-store.ts";
import { GOAL_STATUSES, InvalidGoalTransitionError } from "../domain/goal-state.ts";
import { ProjectMutationError } from "../domain/project-store.ts";
import {
  InvalidMilestoneTransitionError,
  InvalidProjectTransitionError,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
} from "../domain/project-state.ts";
import { SecretMutationError } from "../domain/secret-store.ts";
import { SecretResolutionError } from "../secrets/secret-provider.ts";
import { AttachmentMutationError } from "../domain/attachment-store.ts";
import { RemoteWorkerMutationError } from "../domain/remote-worker-store.ts";
import { MeetingMutationError } from "../domain/meeting-store.ts";
import { InvalidMeetingTransitionError, MEETING_STATUSES } from "../domain/meeting-state.ts";
import { MemoryMutationError } from "../domain/memory-store.ts";
import { MEMORY_KINDS } from "../memory/memory-provider.ts";
import {
  MailboxAccessError,
  MailboxMutationError,
  MAILBOX_ACCESS_LEVELS,
  MAILBOX_KINDS,
} from "../domain/mailbox-store.ts";
import { MarketplaceMutationError, MARKETPLACE_KINDS } from "../domain/marketplace-store.ts";
import { MarketplaceSourceError } from "../marketplace/marketplace-source.ts";
import { MarketplaceInstallError } from "../marketplace/marketplace-installer.ts";
import type { RunEvent } from "../runtime/run-events.ts";

export type Broadcast = (type: string, payload: unknown) => void;

const ceoMessageSchema = z.object({ body: z.string().min(1).max(20000) });
const reviewSchema = z.object({ note: z.string().max(5000).optional() });
const revisionSchema = z.object({ reason: z.string().min(1).max(5000) });
const taskStatusSchema = z.object({ status: z.enum(TASK_STATUSES), reason: z.string().max(2000).optional() });
const taskDependencySchema = z.object({ dependsOnId: z.string().min(1).max(200) });
const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(5000).optional(),
});
const budgetSchema = z.object({
  scopeType: z.enum(["company", "agent", "project", "task", "runtime", "provider"]),
  scopeId: z.string().max(200).optional(),
  limitMicros: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(100).optional(),
  hardStop: z.boolean().optional(),
});
const modelCheckSchema = z.object({
  model: z.string().min(1).max(200),
  provider: z.string().max(200).optional(),
});
const setAgentRuntimeSchema = z.object({ runtimeProvider: z.string().min(1).max(100) });
const createGoalSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  parentId: z.string().max(200).nullable().optional(),
});
const updateGoalSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
});
const goalStatusSchema = z.object({ status: z.enum(GOAL_STATUSES) });
const goalReparentSchema = z.object({ parentId: z.string().max(200).nullable() });
const createProjectSchema = z.object({
  title: z.string().min(1).max(500),
  key: z.string().min(1).max(200).optional(),
  summary: z.string().max(20000).optional(),
  goalId: z.string().max(200).nullable().optional(),
  ownerAgentId: z.string().max(200).nullable().optional(),
  workspacePath: z.string().max(2000).nullable().optional(),
});
const updateProjectSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(20000).optional(),
  goalId: z.string().max(200).nullable().optional(),
  ownerAgentId: z.string().max(200).nullable().optional(),
  workspacePath: z.string().max(2000).nullable().optional(),
});
const projectStatusSchema = z.object({ status: z.enum(PROJECT_STATUSES) });
const createMilestoneSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  dueAt: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const updateMilestoneSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
  dueAt: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const milestoneStatusSchema = z.object({ status: z.enum(MILESTONE_STATUSES) });
const createSecretSchema = z.object({
  name: z.string().min(1).max(200),
  provider: z.enum(["vaultwarden", "protonpass"]),
  itemRef: z.string().min(1).max(500),
  field: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});
const updateSecretSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  itemRef: z.string().min(1).max(500).optional(),
  field: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).optional(),
});
// 8MB decoded, generously rounded up for base64 overhead (~4/3x) — the
// authoritative cutoff is the decoded byte length checked in the upload
// route itself; this just bounds how much undecoded JSON the parser has to
// accept, comfortably under express.json()'s 12mb body limit (server/security/auth.ts).
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const uploadAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(500),
    contentType: z.string().max(200).optional(),
    dataBase64: z.string().min(1).max(11_200_000),
    taskId: z.string().max(200).optional(),
    projectId: z.string().max(200).optional(),
  })
  .refine((v) => !(v.taskId && v.projectId), {
    message: "An attachment may be scoped to a task or a project, not both.",
  });
const createRemoteWorkerSchema = z.object({
  label: z.string().min(1).max(200),
  environment: z.string().max(200).optional(),
  host: z.string().min(1).max(500),
  port: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).max(200),
  privateKeyPath: z.string().min(1).max(1000),
  knownHostsPolicy: z.enum(["strict", "accept"]).optional(),
  notes: z.string().max(2000).optional(),
});
const createMeetingSchema = z.object({
  topic: z.string().min(1).max(500),
  moderatorAgentId: z.string().min(1).max(200),
  participantAgentIds: z.array(z.string().min(1).max(200)).min(1),
  projectId: z.string().max(200).nullable().optional(),
  maxRounds: z.number().int().min(1).max(50).optional(),
  budgetMicros: z.number().int().nonnegative().optional(),
});
const meetingTurnSchema = z.object({ agentId: z.string().min(1).max(200).optional() });
const meetingEndSchema = z.object({ minutes: z.string().max(20000).optional() });
const createActionItemSchema = z.object({
  description: z.string().min(1).max(2000),
  assignedAgentId: z.string().max(200).nullable().optional(),
});
const mailboxCredentialsSchema = z.object({
  password: z.string().max(2000).optional(),
  bearerToken: z.string().max(4000).optional(),
  clientSecret: z.string().max(2000).optional(),
  refreshToken: z.string().max(4000).optional(),
});
const createMailboxSchema = z.object({
  label: z.string().min(1).max(200),
  kind: z.enum(MAILBOX_KINDS),
  emailAddress: z.string().min(1).max(320),
  host: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useTls: z.boolean().optional(),
  username: z.string().max(320).optional(),
  smtpHost: z.string().max(500).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  sessionUrl: z.string().max(2000).optional(),
  tenantId: z.string().max(200).optional(),
  clientId: z.string().max(200).optional(),
  credentials: mailboxCredentialsSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().min(30).max(86_400).optional(),
  autoTriage: z.boolean().optional(),
});
const updateMailboxSchema = createMailboxSchema.partial().omit({ kind: true });
const grantMailboxAgentSchema = z.object({
  agentId: z.string().min(1).max(200),
  access: z.enum(MAILBOX_ACCESS_LEVELS).optional(),
});
const createMarketplaceSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(MARKETPLACE_KINDS),
  url: z.string().min(1).max(2048),
  enabled: z.boolean().optional(),
});

// The kind decides how the URL is parsed, so it stays fixed for the life of
// a source — changing it would silently reinterpret the same URL.
const updateMarketplaceSchema = createMarketplaceSchema.partial().omit({ kind: true });

const installEntrySchema = z.object({
  entryId: z.string().min(1).max(400),
  /** Values for the variables the entry declared but could not carry. */
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Install under a different local name, e.g. to avoid a clash. */
  name: z.string().min(1).max(80).optional(),
});

const sendMailSchema = z.object({
  to: z.array(z.string().min(1).max(320)).min(1).max(50),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(100_000),
  inReplyTo: z.string().max(500).optional(),
  /** When set, the send is performed as that agent and needs its grant. */
  agentId: z.string().max(200).optional(),
});
const createMemorySchema = z.object({
  provider: z.string().min(1).max(100),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(200_000),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  taskId: z.string().max(200).nullable().optional(),
  projectId: z.string().max(200).nullable().optional(),
  agentId: z.string().max(200).nullable().optional(),
  source: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["internal", "confidential", "public"]).optional(),
});

/** Translate domain errors into honest HTTP statuses rather than a blanket 500. */
function sendDomainError(res: Response, err: unknown): boolean {
  if (err instanceof ApprovalRequiredError) {
    res.status(403).json({
      error: "approval_required",
      message: err.message,
      approvalId: err.approvalId,
      approvalType: err.approvalType,
    });
    return true;
  }
  if (err instanceof BudgetExceededError) {
    res.status(402).json({
      error: "budget_exceeded",
      message: err.message,
      scopeType: err.scopeType,
      scopeId: err.scopeId,
    });
    return true;
  }
  if (err instanceof InvalidTransitionError) {
    res.status(409).json({ error: "invalid_transition", message: err.message });
    return true;
  }
  if (err instanceof TaskDependencyError) {
    res.status(400).json({ error: "invalid_task_dependency", message: err.message });
    return true;
  }
  if (err instanceof InvalidGoalTransitionError) {
    res.status(409).json({ error: "invalid_goal_transition", message: err.message });
    return true;
  }
  if (err instanceof GoalMutationError) {
    res.status(400).json({ error: "invalid_goal_mutation", message: err.message });
    return true;
  }
  if (err instanceof InvalidProjectTransitionError) {
    res.status(409).json({ error: "invalid_project_transition", message: err.message });
    return true;
  }
  if (err instanceof InvalidMilestoneTransitionError) {
    res.status(409).json({ error: "invalid_milestone_transition", message: err.message });
    return true;
  }
  if (err instanceof ProjectMutationError) {
    res.status(400).json({ error: "invalid_project_mutation", message: err.message });
    return true;
  }
  if (err instanceof SecretMutationError) {
    res.status(400).json({ error: "invalid_secret_mutation", message: err.message });
    return true;
  }
  // SecretResolutionError is deliberately NOT mapped here — the one place it
  // can be thrown from a route (POST /secrets/:id/test) catches it locally
  // and reports {ok:false, message} with a 200, since "the vault couldn't
  // resolve this ref right now" is a status the UI displays, not a client
  // request error.
  if (err instanceof AttachmentMutationError) {
    res.status(400).json({ error: "invalid_attachment_mutation", message: err.message });
    return true;
  }
  if (err instanceof RemoteWorkerMutationError) {
    res.status(400).json({ error: "invalid_remote_worker_mutation", message: err.message });
    return true;
  }
  if (err instanceof InvalidMeetingTransitionError) {
    res.status(409).json({ error: "invalid_meeting_transition", message: err.message });
    return true;
  }
  if (err instanceof MeetingMutationError) {
    res.status(400).json({ error: "invalid_meeting_mutation", message: err.message });
    return true;
  }
  if (err instanceof MemoryMutationError) {
    res.status(400).json({ error: "invalid_memory_mutation", message: err.message });
    return true;
  }
  // A refused grant is not a malformed request — it is a permission answer.
  if (err instanceof MailboxAccessError) {
    res.status(403).json({ error: "mailbox_access_denied", message: err.message });
    return true;
  }
  if (err instanceof MailboxMutationError) {
    res.status(400).json({ error: "invalid_mailbox_mutation", message: err.message });
    return true;
  }
  if (err instanceof MarketplaceMutationError) {
    res.status(400).json({ error: "invalid_marketplace_mutation", message: err.message });
    return true;
  }
  // The request was fine; someone else's server was not. 502 says which of
  // the two failed, where a 400 would blame the caller for a broken catalog.
  if (err instanceof MarketplaceSourceError) {
    res.status(502).json({ error: "marketplace_unreachable", message: err.message });
    return true;
  }
  // A refused install is a policy answer about this machine (an unallowed
  // launcher, an oversized skill), not a malformed request body.
  if (err instanceof MarketplaceInstallError) {
    res.status(422).json({ error: "install_refused", message: err.message });
    return true;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", issues: err.issues });
    return true;
  }
  return false;
}

/** Express 5 types params as `string | string[]`; routes here take one value. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function wrap(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!sendDomainError(res, err)) next(err);
    }
  };
}

export interface IronCrewApiOptions {
  db: DatabaseSync;
  broadcast?: Broadcast;
  /** Company slug this installation operates. */
  companySlug?: string;
  companyName?: string;
  orchestrator?: CompanyOrchestrator;
}

export interface IronCrewApi {
  orchestrator: CompanyOrchestrator;
  companyId: string;
}

export function registerIronCrewRoutes(app: Express, opts: IronCrewApiOptions): IronCrewApi {
  const { db } = opts;
  const broadcast: Broadcast = opts.broadcast ?? (() => {});

  const orchestrator = opts.orchestrator ?? new CompanyOrchestrator(db);
  if (!opts.orchestrator) orchestrator.registerRuntime(new MockRuntime());

  const companyId = orchestrator.seedCompany({
    name: opts.companyName ?? "IronCrew",
    slug: opts.companySlug ?? "iron-crew",
  });

  const base = "/api/crew";

  // --- company / org ------------------------------------------------------

  app.get(
    `${base}/company`,
    wrap((_req, res) => {
      const company = db.prepare("SELECT * FROM crew_companies WHERE id = ?").get(companyId);
      const departments = db
        .prepare("SELECT * FROM crew_departments WHERE company_id = ? ORDER BY sort_order")
        .all(companyId);
      res.json({ company, departments });
    }),
  );

  /**
   * One agent shape for every endpoint that returns an agent, so a client
   * never has to handle both a mapped shape and a raw database row.
   */
  const presentAgent = (a: AgentRow) => ({
    id: a.id,
    key: a.key,
    displayName: a.display_name,
    professionalRole: a.professional_role,
    roleSummary: a.role_summary,
    seniority: a.seniority,
    departmentId: a.department_id,
    // Vessel × Talent: which container executes this agent, and which
    // capability package it carries. Both are ids the UI can follow, plus the
    // resolved values so a caller need not fetch three things to show one row.
    vesselId: a.vessel_id,
    vesselKey: a.vessel_key,
    runtimeProvider: a.runtime_provider,
    talentId: a.talent_id,
    talentKey: a.talent_key,
    skills: JSON.parse(a.skills_json) as string[],
    isExecutiveAssistant: a.is_executive_assistant === 1,
    // Persona is cosmetic; policy is authoritative. Both are exposed so the
    // UI can show that they are separate, but they are never merged.
    persona: JSON.parse(a.persona_json),
    policy: JSON.parse(a.policy_json),
    status: orchestrator.agentStatus(companyId, a.id),
  });

  app.get(
    `${base}/agents`,
    wrap((_req, res) => {
      res.json({ agents: orchestrator.listAgents(companyId).map(presentAgent) });
    }),
  );

  app.patch(
    `${base}/agents/:id/runtime`,
    wrap((req, res) => {
      const { runtimeProvider } = setAgentRuntimeSchema.parse(req.body ?? {});
      const registered = orchestrator.listRuntimes().map((r) => r.type);
      if (!registered.includes(runtimeProvider)) {
        res
          .status(400)
          .json({ error: "unknown_runtime", message: `No runtime registered for "${runtimeProvider}".`, registered });
        return;
      }
      const agent = orchestrator.setAgentRuntimeProvider(companyId, param(req, "id"), runtimeProvider);
      if (!agent) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_agent_changed", { agentId: agent.id, runtimeProvider: agent.runtime_provider });
      res.json({ agent: presentAgent(agent) });
    }),
  );

  // --- runtime providers ---------------------------------------------------

  /**
   * Provider Health: capabilities/health/auth for every runtime registered
   * with this orchestrator, mock and real CLI adapters alike. Each of these
   * three calls does its own capability probe (e.g. `claude --version`) per
   * the AgentRuntime contract, so this is meant for an on-demand panel, not
   * a tight poll. Never carries a token — AuthStatus.accountHint is
   * contractually non-identifying (docs/PROVIDER_AUTH.md).
   */
  app.get(
    `${base}/runtimes`,
    wrap(async (_req, res) => {
      const runtimes = await Promise.all(
        orchestrator.listRuntimes().map(async (r) => ({
          type: r.type,
          capabilities: await r.capabilities(),
          health: await r.healthCheck(),
          auth: await r.authStatus(),
        })),
      );
      res.json({ runtimes });
    }),
  );

  // --- CEO chat -----------------------------------------------------------

  app.get(
    `${base}/chat`,
    wrap((_req, res) => {
      const conversationId = orchestrator.ensureCeoConversation(companyId);
      res.json({ conversationId, messages: orchestrator.listMessages(conversationId) });
    }),
  );

  app.post(
    `${base}/chat`,
    wrap((req, res) => {
      const { body } = ceoMessageSchema.parse(req.body);
      const result = orchestrator.handleCeoMessage(companyId, body);
      broadcast("crew_chat_message", { conversationId: result.conversationId, reply: result.reply });
      if (result.task) broadcast("crew_task_changed", { taskId: result.task.id, status: result.task.status });
      res.status(201).json({
        ...result,
        // Same agent shape as /agents, rather than a raw database row.
        assignedAgent: result.assignedAgent ? presentAgent(result.assignedAgent) : null,
      });
    }),
  );

  // --- tasks --------------------------------------------------------------

  app.get(
    `${base}/tasks`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: TASK_STATUSES });
        return;
      }
      res.json({ tasks: orchestrator.tasks.list(companyId, { status: status as never }) });
    }),
  );

  app.get(
    `${base}/tasks/:id`,
    wrap((req, res) => {
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        task,
        runs: orchestrator.runs.listForTask(task.id),
        blockers: orchestrator.tasks.blockers(task.id),
        blocking: orchestrator.tasks.blocking(task.id),
        audit: listAuditEvents(db, companyId, { taskId: task.id, limit: 200 }),
      });
    }),
  );

  /** Execute the next claimable task. Streams events over the websocket. */
  app.post(
    `${base}/tasks/execute-next`,
    wrap(async (_req, res) => {
      const result = await orchestrator.executeNextTask(companyId, {
        onEvent: (e: RunEvent) => broadcast("crew_run_event", e),
      });
      if (!result) {
        res.json({ executed: false, reason: "nothing claimable" });
        return;
      }
      broadcast("crew_task_changed", { taskId: result.task.id, status: result.task.status });
      res.json({ executed: true, task: result.task, runId: result.runId, eventCount: result.events.length });
    }),
  );

  app.post(
    `${base}/tasks/:id/accept`,
    wrap((req, res) => {
      const { note } = reviewSchema.parse(req.body ?? {});
      const task = orchestrator.acceptReview(companyId, param(req, "id"), note ?? "");
      if (!task) {
        res.status(409).json({ error: "cannot_accept", message: "Task is not in a reviewable state." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  app.post(
    `${base}/tasks/:id/revise`,
    wrap((req, res) => {
      const { reason } = revisionSchema.parse(req.body ?? {});
      const task = orchestrator.requestRevision(companyId, param(req, "id"), reason);
      if (!task) {
        res.status(409).json({ error: "cannot_revise", message: "Task is not in a reviewable state." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  /**
   * Generic status move — the Kanban board's server-side validation. Every
   * drag from one column to another lands here, and `TaskStore.transition()`
   * is the only thing that decides whether the move is legal (the same state
   * machine `executeNextTask`/`acceptReview`/`requestRevision` already go
   * through); an illegal move throws `InvalidTransitionError`, mapped to 409
   * by `sendDomainError`, and the frontend never applies it locally — the
   * board only ever reflects what this endpoint actually returns.
   */
  app.post(
    `${base}/tasks/:id/status`,
    wrap((req, res) => {
      const { status, reason } = taskStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.tasks.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const task = orchestrator.tasks.transition(existing.id, status, {
        reason: reason ?? "moved on the board",
        actorType: "owner",
        actorId: "ceo",
        correlationId: existing.correlation_id,
      });
      if (!task) {
        res.status(409).json({ error: "cannot_transition", message: "Task status changed concurrently." });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ task });
    }),
  );

  app.post(
    `${base}/tasks/:id/dependencies`,
    wrap((req, res) => {
      const { dependsOnId } = taskDependencySchema.parse(req.body ?? {});
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const blocker = orchestrator.tasks.get(dependsOnId);
      if (!blocker || blocker.company_id !== companyId) {
        res.status(404).json({ error: "depends_on_not_found" });
        return;
      }
      orchestrator.tasks.addDependency(companyId, task.id, dependsOnId, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.status(201).json({ blockers: orchestrator.tasks.blockers(task.id) });
    }),
  );

  app.delete(
    `${base}/tasks/:id/dependencies/:dependsOnId`,
    wrap((req, res) => {
      const task = orchestrator.tasks.get(param(req, "id"));
      if (!task || task.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.tasks.removeDependency(companyId, task.id, param(req, "dependsOnId"), {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.json({ blockers: orchestrator.tasks.blockers(task.id) });
    }),
  );

  // --- goals ----------------------------------------------------------------

  app.get(
    `${base}/goals`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(GOAL_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: GOAL_STATUSES });
        return;
      }
      const topLevel = req.query.topLevel === "true";
      const parentId = typeof req.query.parentId === "string" ? req.query.parentId : undefined;
      res.json({
        goals: orchestrator.goals.list(companyId, {
          status: status as never,
          parentId: topLevel ? null : parentId,
        }),
      });
    }),
  );

  app.get(
    `${base}/goals/:id`,
    wrap((req, res) => {
      const goal = orchestrator.goals.get(param(req, "id"));
      if (!goal || goal.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        goal,
        ancestry: orchestrator.goals.ancestry(goal.id),
        children: orchestrator.goals.children(goal.id),
      });
    }),
  );

  app.post(
    `${base}/goals`,
    wrap((req, res) => {
      const input = createGoalSchema.parse(req.body ?? {});
      const goal = orchestrator.goals.create({ companyId, ...input });
      broadcast("crew_goal_changed", { goalId: goal.id });
      res.status(201).json({ goal });
    }),
  );

  app.patch(
    `${base}/goals/:id`,
    wrap((req, res) => {
      const patch = updateGoalSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const goal = orchestrator.goals.update(existing.id, patch);
      broadcast("crew_goal_changed", { goalId: existing.id });
      res.json({ goal });
    }),
  );

  app.post(
    `${base}/goals/:id/status`,
    wrap((req, res) => {
      const { status } = goalStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const goal = orchestrator.goals.setStatus(existing.id, status, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_goal_changed", { goalId: existing.id, status });
      res.json({ goal });
    }),
  );

  app.post(
    `${base}/goals/:id/reparent`,
    wrap((req, res) => {
      const { parentId } = goalReparentSchema.parse(req.body ?? {});
      const existing = orchestrator.goals.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (parentId) {
        const parent = orchestrator.goals.get(parentId);
        if (!parent || parent.company_id !== companyId) {
          res.status(404).json({ error: "parent_not_found" });
          return;
        }
      }
      const goal = orchestrator.goals.reparent(existing.id, parentId, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_goal_changed", { goalId: existing.id });
      res.json({ goal });
    }),
  );

  // --- projects and milestones ---------------------------------------------

  app.get(
    `${base}/projects`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(PROJECT_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: PROJECT_STATUSES });
        return;
      }
      const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
      res.json({ projects: orchestrator.projects.list(companyId, { status: status as never, goalId }) });
    }),
  );

  /** Project detail view: the project itself, its milestones and its tasks. */
  app.get(
    `${base}/projects/:id`,
    wrap((req, res) => {
      const project = orchestrator.projects.get(param(req, "id"));
      if (!project || project.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        project,
        milestones: orchestrator.projects.listMilestones(project.id),
        tasks: orchestrator.tasks.list(companyId, { projectId: project.id }),
      });
    }),
  );

  app.post(
    `${base}/projects`,
    wrap((req, res) => {
      const input = createProjectSchema.parse(req.body ?? {});
      const project = orchestrator.projects.create({ companyId, ...input });
      broadcast("crew_project_changed", { projectId: project.id });
      res.status(201).json({ project });
    }),
  );

  app.patch(
    `${base}/projects/:id`,
    wrap((req, res) => {
      const patch = updateProjectSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const project = orchestrator.projects.update(existing.id, patch);
      broadcast("crew_project_changed", { projectId: existing.id });
      res.json({ project });
    }),
  );

  app.post(
    `${base}/projects/:id/status`,
    wrap((req, res) => {
      const { status } = projectStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const project = orchestrator.projects.setStatus(existing.id, status, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_project_changed", { projectId: existing.id, status });
      res.json({ project });
    }),
  );

  app.post(
    `${base}/projects/:id/milestones`,
    wrap((req, res) => {
      const input = createMilestoneSchema.parse(req.body ?? {});
      const project = orchestrator.projects.get(param(req, "id"));
      if (!project || project.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.addMilestone({ companyId, projectId: project.id, ...input });
      broadcast("crew_project_changed", { projectId: project.id });
      res.status(201).json({ milestone });
    }),
  );

  app.patch(
    `${base}/milestones/:id`,
    wrap((req, res) => {
      const patch = updateMilestoneSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.getMilestone(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.updateMilestone(existing.id, patch);
      broadcast("crew_project_changed", { projectId: existing.project_id });
      res.json({ milestone });
    }),
  );

  app.post(
    `${base}/milestones/:id/status`,
    wrap((req, res) => {
      const { status } = milestoneStatusSchema.parse(req.body ?? {});
      const existing = orchestrator.projects.getMilestone(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const milestone = orchestrator.projects.setMilestoneStatus(existing.id, status, {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_project_changed", { projectId: existing.project_id, status });
      res.json({ milestone });
    }),
  );

  // --- runs ---------------------------------------------------------------

  app.get(
    `${base}/runs/:id/events`,
    wrap((req, res) => {
      const run = orchestrator.runs.get(param(req, "id"));
      if (!run || run.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const afterSeq = Number(req.query.afterSeq ?? -1);
      res.json({ run, events: orchestrator.runs.listEvents(run.id, { afterSeq }) });
    }),
  );

  // --- approvals ----------------------------------------------------------

  app.get(
    `${base}/approvals`,
    wrap((_req, res) => {
      res.json({ approvals: orchestrator.approvals.listPending(companyId) });
    }),
  );

  app.post(
    `${base}/approvals/:id/decide`,
    wrap((req, res) => {
      const { decision, reason } = decisionSchema.parse(req.body ?? {});
      const approval = orchestrator.decideApproval(companyId, param(req, "id"), decision, reason ?? "");
      if (!approval) {
        res.status(409).json({ error: "already_decided", message: "This approval is no longer pending." });
        return;
      }
      broadcast("crew_approval_decided", { approvalId: approval.id, status: approval.status });
      res.json({ approval });
    }),
  );

  // --- decision inbox: notifications + decision log ------------------------

  app.get(
    `${base}/notifications`,
    wrap((req, res) => {
      const unreadOnly = req.query.unread === "true";
      res.json({
        notifications: orchestrator.notifications.list(companyId, { unreadOnly }),
        unreadCount: orchestrator.notifications.countUnread(companyId),
      });
    }),
  );

  app.post(
    `${base}/notifications/:id/read`,
    wrap((req, res) => {
      const notification = orchestrator.notifications.get(param(req, "id"));
      if (!notification || notification.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const updated = orchestrator.notifications.markRead(notification.id);
      broadcast("crew_notification_read", { notificationId: notification.id });
      res.json({ notification: updated });
    }),
  );

  app.get(
    `${base}/decisions`,
    wrap((req, res) => {
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      res.json({ decisions: orchestrator.decisions.list(companyId, { taskId, projectId }) });
    }),
  );

  // --- secrets (password-manager integration) ------------------------------
  //
  // Only ever returns SecretRef rows (name/provider/itemRef/field) — never a
  // resolved value. The one exception is POST /secrets/:id/test, which
  // resolves the value in memory to prove the ref actually works, then
  // reports only {ok, message} — the value itself never leaves the server.

  app.get(
    `${base}/secret-providers`,
    wrap(async (_req, res) => {
      const kinds: Array<"vaultwarden" | "protonpass"> = ["vaultwarden", "protonpass"];
      const providers = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          registered: orchestrator.listSecretProviderKinds().includes(kind),
          ...(await orchestrator.testSecretProvider(kind)),
        })),
      );
      res.json({ providers });
    }),
  );

  app.get(
    `${base}/secrets`,
    wrap((_req, res) => {
      res.json({ secrets: orchestrator.secrets.list(companyId) });
    }),
  );

  app.post(
    `${base}/secrets`,
    wrap((req, res) => {
      const input = createSecretSchema.parse(req.body ?? {});
      const secret = orchestrator.secrets.create({ companyId, ...input, actorType: "owner", actorId: "ceo" });
      broadcast("crew_secret_changed", { secretId: secret.id });
      res.status(201).json({ secret });
    }),
  );

  app.patch(
    `${base}/secrets/:id`,
    wrap((req, res) => {
      const patch = updateSecretSchema.parse(req.body ?? {});
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const secret = orchestrator.secrets.update(existing.id, patch, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_secret_changed", { secretId: existing.id });
      res.json({ secret });
    }),
  );

  app.delete(
    `${base}/secrets/:id`,
    wrap((req, res) => {
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.secrets.delete(existing.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_secret_changed", { secretId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/secrets/:id/test`,
    wrap(async (req, res) => {
      const existing = orchestrator.secrets.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      try {
        const value = await orchestrator.resolveSecret(companyId, existing.id, { actorType: "owner", actorId: "ceo" });
        res.json({ ok: true, length: value.length });
      } catch (err) {
        if (err instanceof SecretResolutionError) {
          res.json({ ok: false, message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  // --- attachments (task/project-scoped + the general document store) -----

  app.get(
    `${base}/attachments`,
    wrap((req, res) => {
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      if (taskId) {
        res.json({ attachments: orchestrator.attachments.listForTask(companyId, taskId) });
      } else if (projectId) {
        res.json({ attachments: orchestrator.attachments.listForProject(companyId, projectId) });
      } else {
        res.json({ attachments: orchestrator.attachments.listGeneral(companyId) });
      }
    }),
  );

  app.post(
    `${base}/attachments`,
    wrap((req, res) => {
      const input = uploadAttachmentSchema.parse(req.body ?? {});
      const buffer = Buffer.from(input.dataBase64, "base64");
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        res.status(413).json({
          error: "attachment_too_large",
          message: `Attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB.`,
        });
        return;
      }
      const attachment = orchestrator.uploadAttachment(companyId, {
        filename: input.filename,
        contentType: input.contentType,
        buffer,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_attachment_changed", { attachmentId: attachment.id });
      res.status(201).json({ attachment });
    }),
  );

  app.get(
    `${base}/attachments/:id/download`,
    wrap((req, res) => {
      const found = orchestrator.readAttachment(companyId, param(req, "id"));
      if (!found) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const asciiFallback = found.row.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
      res.setHeader("Content-Type", found.row.content_type);
      res.setHeader("Content-Length", String(found.buffer.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(found.row.filename)}`,
      );
      res.send(found.buffer);
    }),
  );

  app.delete(
    `${base}/attachments/:id`,
    wrap((req, res) => {
      const deleted = orchestrator.deleteAttachment(companyId, param(req, "id"), {
        actorType: "owner",
        actorId: "ceo",
      });
      if (!deleted) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_attachment_changed", { attachmentId: param(req, "id"), deleted: true });
      res.json({ ok: true });
    }),
  );

  // --- network (Tailscale/Headscale status + remote workers over the tailnet) ---

  app.get(
    `${base}/tailscale`,
    wrap(async (_req, res) => {
      try {
        const [status, connection] = await Promise.all([orchestrator.tailscaleStatus(), orchestrator.testTailscale()]);
        res.json({ ...status, ok: connection.ok, message: connection.message });
      } catch (err) {
        res.json({
          backendState: "Unknown",
          self: null,
          peers: [],
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  app.get(
    `${base}/remote-workers`,
    wrap((_req, res) => {
      res.json({ remoteWorkers: orchestrator.remoteWorkers.list(companyId) });
    }),
  );

  app.post(
    `${base}/remote-workers`,
    wrap((req, res) => {
      const input = createRemoteWorkerSchema.parse(req.body ?? {});
      const worker = orchestrator.remoteWorkers.create({ companyId, ...input, actorType: "owner", actorId: "ceo" });
      broadcast("crew_remote_worker_changed", { remoteWorkerId: worker.id });
      res.status(201).json({ remoteWorker: worker });
    }),
  );

  app.delete(
    `${base}/remote-workers/:id`,
    wrap((req, res) => {
      const existing = orchestrator.remoteWorkers.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.remoteWorkers.delete(existing.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_remote_worker_changed", { remoteWorkerId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/remote-workers/:id/test`,
    wrap(async (req, res) => {
      const existing = orchestrator.remoteWorkers.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await orchestrator.testRemoteWorker(companyId, existing.id));
    }),
  );

  // --- meetings -------------------------------------------------------------
  //
  // One round is one participant's turn (round-robin by default, or the
  // moderator can pick an explicit speaker) — total turns are bounded by
  // max_rounds alone, never multiplied by participant count. A meeting
  // self-closes the moment max_rounds or its own budget cap is reached;
  // POST .../next-turn after that is a safe no-op ({turn: null}), so the
  // UI can keep calling it without special-casing "is this meeting over".

  app.get(
    `${base}/meetings`,
    wrap((req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(MEETING_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "invalid_status", allowed: MEETING_STATUSES });
        return;
      }
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      res.json({ meetings: orchestrator.meetings.list(companyId, { status: status as never, projectId }) });
    }),
  );

  app.post(
    `${base}/meetings`,
    wrap((req, res) => {
      const input = createMeetingSchema.parse(req.body ?? {});
      const meeting = orchestrator.meetings.create({
        companyId,
        ...input,
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.status(201).json({ meeting });
    }),
  );

  app.get(
    `${base}/meetings/:id`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        meeting,
        participants: orchestrator.meetings.participants(meeting.id),
        turns: orchestrator.meetings.turns(meeting.id),
        actionItems: orchestrator.meetings.actionItems(meeting.id),
      });
    }),
  );

  app.post(
    `${base}/meetings/:id/start`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const started = orchestrator.meetings.start(meeting.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: started });
    }),
  );

  app.post(
    `${base}/meetings/:id/next-turn`,
    wrap(async (req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { agentId } = meetingTurnSchema.parse(req.body ?? {});
      const result = await orchestrator.runMeetingTurn(companyId, meeting.id, { agentId });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: result?.meeting ?? orchestrator.meetings.get(meeting.id), turn: result?.turn ?? null });
    }),
  );

  app.post(
    `${base}/meetings/:id/end`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { minutes } = meetingEndSchema.parse(req.body ?? {});
      const ended = orchestrator.meetings.end(meeting.id, minutes ?? meeting.minutes, {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: ended });
    }),
  );

  app.post(
    `${base}/meetings/:id/cancel`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const cancelled = orchestrator.meetings.cancel(meeting.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.json({ meeting: cancelled });
    }),
  );

  app.post(
    `${base}/meetings/:id/action-items`,
    wrap((req, res) => {
      const meeting = orchestrator.meetings.get(param(req, "id"));
      if (!meeting || meeting.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const input = createActionItemSchema.parse(req.body ?? {});
      const item = orchestrator.meetings.addActionItem({
        meetingId: meeting.id,
        ...input,
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_meeting_changed", { meetingId: meeting.id });
      res.status(201).json({ actionItem: item });
    }),
  );

  app.post(
    `${base}/meetings/action-items/:id/convert`,
    wrap((req, res) => {
      const item = orchestrator.meetings.getActionItem(param(req, "id"));
      if (!item) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const task = orchestrator.convertActionItemToTask(companyId, item.id, { actorType: "owner", actorId: "ceo" });
      if (!task) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      res.status(201).json({ task });
    }),
  );

  // --- memory (Obsidian vault, the first MemoryProvider) ------------------
  //
  // A memory entry's real content is written and read through its
  // provider (a markdown file in an Obsidian vault, for the "obsidian"
  // kind) — this API only ever persists/returns the reference
  // (crew_memory_refs): provider, external locator, title, provenance.
  // GET /memory/:id is the one exception, mirroring how POST /secrets/:id/test
  // resolves a secret value in memory without ever storing it here — content
  // is read live from the provider and returned, never cached in the DB.

  app.get(
    `${base}/memory-providers`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listMemoryProviderKinds();
      const providers = await Promise.all(
        kinds.map(async (kind) => ({ kind, registered: true, ...(await orchestrator.testMemoryProvider(kind)) })),
      );
      res.json({ providers });
    }),
  );

  app.get(
    `${base}/memory`,
    wrap((req, res) => {
      const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      if (kind && !(MEMORY_KINDS as readonly string[]).includes(kind)) {
        res.status(400).json({ error: "invalid_kind", allowed: MEMORY_KINDS });
        return;
      }
      const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      res.json({
        memories: orchestrator.memories.list(companyId, { kind: kind as never, taskId, projectId, agentId }),
      });
    }),
  );

  app.get(
    `${base}/memory/search`,
    wrap(async (req, res) => {
      const provider = typeof req.query.provider === "string" ? req.query.provider : "";
      const query = typeof req.query.q === "string" ? req.query.q : "";
      if (!provider || !query) {
        res.status(400).json({ error: "invalid_request", message: "provider and q query params are required." });
        return;
      }
      res.json({ hits: await orchestrator.searchMemory(provider, query) });
    }),
  );

  app.post(
    `${base}/memory`,
    wrap(async (req, res) => {
      const input = createMemorySchema.parse(req.body ?? {});
      const ref = await orchestrator.recordMemory(companyId, input.provider, input, {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_memory_changed", { memoryId: ref.id });
      res.status(201).json({ memory: ref });
    }),
  );

  app.get(
    `${base}/memory/:id`,
    wrap(async (req, res) => {
      const result = await orchestrator.readMemoryContent(companyId, param(req, "id"));
      if (!result) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ memory: result.ref, content: result.content });
    }),
  );

  app.delete(
    `${base}/memory/:id`,
    wrap(async (req, res) => {
      const deleted = await orchestrator.deleteMemory(companyId, param(req, "id"), {
        actorType: "owner",
        actorId: "ceo",
      });
      if (!deleted) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_memory_changed", { memoryId: param(req, "id"), deleted: true });
      res.json({ ok: true });
    }),
  );

  // --- mailboxes (IMAP, JMAP, Microsoft 365, Gmail) ------------------------
  //
  // A mailbox row never carries its credentials (see mailbox-store.ts), so
  // no response here can leak them — the write endpoints accept them, and
  // nothing reads them back out. Messages are not stored: the list and read
  // endpoints go to the mail server live, so this API is a window onto the
  // mailbox rather than a copy of it.

  app.get(
    `${base}/mail-providers`,
    wrap((_req, res) => {
      const registered = orchestrator.listMailProviderKinds();
      res.json({
        providers: MAILBOX_KINDS.map((kind) => ({ kind, registered: registered.includes(kind) })),
      });
    }),
  );

  app.get(
    `${base}/mailboxes`,
    wrap((_req, res) => {
      const mailboxes = orchestrator.mailboxes.list(companyId).map((mailbox) => ({
        ...mailbox,
        agents: orchestrator.mailboxes.agentsFor(mailbox.id),
      }));
      res.json({ mailboxes });
    }),
  );

  app.post(
    `${base}/mailboxes`,
    wrap((req, res) => {
      const input = createMailboxSchema.parse(req.body ?? {});
      const mailbox = orchestrator.mailboxes.create({
        companyId,
        ...input,
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_mailbox_changed", { mailboxId: mailbox.id });
      res.status(201).json({ mailbox });
    }),
  );

  app.get(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const mailbox = orchestrator.mailboxes.get(param(req, "id"));
      if (!mailbox || mailbox.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        mailbox,
        agents: orchestrator.mailboxes.agentsFor(mailbox.id),
        messages: orchestrator.mailboxes.messages(mailbox.id, 50),
      });
    }),
  );

  app.patch(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { credentials, ...patch } = updateMailboxSchema.parse(req.body ?? {});
      const mailbox = orchestrator.mailboxes.update(existing.id, patch, { actorType: "owner", actorId: "ceo" });
      // Credentials are replaced wholesale rather than merged: a partial
      // update of a secret is how stale halves of a credential survive.
      if (credentials) orchestrator.mailboxes.writeCredentials(existing.id, credentials);
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.json({ mailbox });
    }),
  );

  app.delete(
    `${base}/mailboxes/:id`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      orchestrator.mailboxes.delete(existing.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_mailbox_changed", { mailboxId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/test`,
    wrap(async (req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await orchestrator.testMailbox(companyId, existing.id));
    }),
  );

  // --- who may work this mailbox (the n:n grants) --------------------------

  app.post(
    `${base}/mailboxes/:id/agents`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { agentId, access } = grantMailboxAgentSchema.parse(req.body ?? {});
      const agents = orchestrator.mailboxes.grantAgent(existing.id, agentId, access ?? "read", {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.status(201).json({ agents });
    }),
  );

  app.delete(
    `${base}/mailboxes/:id/agents/:agentId`,
    wrap((req, res) => {
      const existing = orchestrator.mailboxes.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const revoked = orchestrator.mailboxes.revokeAgent(existing.id, param(req, "agentId"), {
        actorType: "owner",
        actorId: "ceo",
      });
      if (!revoked) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      broadcast("crew_mailbox_changed", { mailboxId: existing.id });
      res.json({ agents: orchestrator.mailboxes.agentsFor(existing.id) });
    }),
  );

  // --- live mail -----------------------------------------------------------

  app.get(
    `${base}/mailboxes/:id/messages`,
    wrap(async (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      res.json({
        messages: await orchestrator.listMailboxMessages(companyId, param(req, "id"), { limit, agentId }),
      });
    }),
  );

  app.get(
    `${base}/mailboxes/:id/messages/:externalId`,
    wrap(async (req, res) => {
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      const message = await orchestrator.readMailboxMessage(companyId, param(req, "id"), param(req, "externalId"), {
        agentId,
      });
      if (!message) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ message });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/send`,
    wrap(async (req, res) => {
      const { agentId, ...mail } = sendMailSchema.parse(req.body ?? {});
      await orchestrator.sendFromMailbox(companyId, param(req, "id"), mail, { agentId });
      res.json({ ok: true });
    }),
  );

  app.post(
    `${base}/mailboxes/:id/poll`,
    wrap(async (req, res) => {
      const result = await orchestrator.pollMailbox(companyId, param(req, "id"));
      broadcast("crew_mailbox_changed", { mailboxId: result.mailbox.id });
      for (const task of result.tasksCreated) {
        broadcast("crew_task_changed", { taskId: task.id, status: task.status });
      }
      res.json({
        mailbox: result.mailbox,
        seen: result.seen,
        newMessages: result.newMessages,
        tasksCreated: result.tasksCreated.length,
      });
    }),
  );

  app.post(
    `${base}/mailboxes/poll-due`,
    wrap(async (_req, res) => {
      const results = await orchestrator.pollDueMailboxes(companyId);
      if (results.length > 0) broadcast("crew_mailbox_changed", { polled: results.length });
      res.json({ results });
    }),
  );

  // --- notification channels (Discord, Telegram, email) -------------------
  //
  // Fan-out targets for the decision inbox — see company.ts#fanOutNotification.
  // Registering a channel happens at server startup (server-main.ts), from
  // env vars; this surface only ever reports status and lets an operator
  // prove a channel actually works, the same "testConnection() vs. really
  // send" split /secrets/:id/test uses.

  app.get(
    `${base}/notification-channels`,
    wrap(async (_req, res) => {
      const kinds = orchestrator.listNotificationChannelKinds();
      const channels = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          registered: true,
          ...(await orchestrator.testNotificationChannel(kind)),
        })),
      );
      res.json({ channels });
    }),
  );

  app.post(
    `${base}/notification-channels/:kind/test`,
    wrap(async (req, res) => {
      res.json(await orchestrator.testNotificationChannel(param(req, "kind")));
    }),
  );

  app.post(
    `${base}/notification-channels/:kind/send-test`,
    wrap(async (req, res) => {
      res.json(await orchestrator.sendTestNotification(param(req, "kind")));
    }),
  );

  // --- budgets and costs --------------------------------------------------

  app.get(
    `${base}/budgets`,
    wrap((_req, res) => {
      res.json({ budgets: orchestrator.budgets.status(companyId) });
    }),
  );

  app.put(
    `${base}/budgets`,
    wrap((req, res) => {
      const parsed = budgetSchema.parse(req.body ?? {});
      res.json({ budget: orchestrator.budgets.setBudget({ companyId, ...parsed }) });
    }),
  );

  // --- governance surfaces ------------------------------------------------

  app.get(
    `${base}/audit`,
    wrap((req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 1000);
      res.json({
        events: listAuditEvents(db, companyId, { limit }),
        chain: verifyAuditChain(db, companyId),
      });
    }),
  );

  app.get(
    `${base}/vendor-policy`,
    wrap((_req, res) => {
      const policy = getVendorPolicy();
      res.json({
        version: policy.version,
        policyName: policy.policy_name,
        allowedFamilies: policy.allowed_families,
        blockedFamilies: policy.blocked_families.map((f) => ({ id: f.id, reason: f.reason })),
        openrouter: policy.openrouter,
        telemetry: policy.telemetry,
      });
    }),
  );

  /**
   * Model admission check. This is the same call the execution path makes, so
   * the UI cannot show a model as usable that the backend would refuse.
   */
  app.post(
    `${base}/vendor-policy/check`,
    wrap((req, res) => {
      const { model, provider } = modelCheckSchema.parse(req.body ?? {});
      const decision = evaluateModel(getVendorPolicy(), model, provider);
      res.status(decision.allowed ? 200 : 403).json({ model, provider: provider ?? null, decision });
    }),
  );

  app.post(
    `${base}/vendor-policy/filter`,
    wrap((req, res) => {
      const models = z
        .array(z.object({ id: z.string(), provider: z.string().optional() }))
        .parse((req.body ?? {}).models ?? []);
      res.json(filterModelCatalogue(getVendorPolicy(), models));
    }),
  );

  // --- dashboard ----------------------------------------------------------

  app.get(
    `${base}/dashboard`,
    wrap((_req, res) => {
      const counts = db
        .prepare("SELECT status, COUNT(*) AS n FROM crew_tasks WHERE company_id = ? GROUP BY status")
        .all(companyId) as unknown as Array<{ status: string; n: number }>;
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
      const agents = orchestrator.listAgents(companyId);
      const agentStates = agents.map((a) => orchestrator.agentStatus(companyId, a.id));

      res.json({
        // Every figure names its source and the moment it was read, so the UI
        // never shows a number without provenance.
        generatedAt: Date.now(),
        source: "crew_tasks / crew_agents / crew_approvals / crew_cost_events (live)",
        tasks: {
          running: byStatus.running ?? 0,
          blocked: byStatus.blocked ?? 0,
          review: byStatus.review ?? 0,
          approvalRequired: byStatus.approval_required ?? 0,
          done: byStatus.done ?? 0,
          failed: byStatus.failed ?? 0,
          total: counts.reduce((sum, c) => sum + c.n, 0),
        },
        agents: {
          total: agents.length,
          working: agentStates.filter((s) => s === "working").length,
          rateLimited: agentStates.filter((s) => s === "rate_limited").length,
          waitingForApproval: agentStates.filter((s) => s === "waiting_for_approval").length,
        },
        approvalsPending: orchestrator.approvals.listPending(companyId).length,
        budgets: orchestrator.budgets.status(companyId),
        auditChainValid: verifyAuditChain(db, companyId).valid,
      });
    }),
  );

  // --- marketplaces: skills and MCP servers from outside this machine -----
  //
  // Browsing and installing are separate on purpose. A catalog is somebody
  // else's JSON that can change between two page loads, so entries are read
  // live (GET .../entries) and never cached as installable commands; only
  // what was actually installed is stored, with its provenance.
  //
  // Install takes an entry *id*, never an entry body: the server re-fetches
  // it from the source, so what lands is what that source offers now rather
  // than a payload a caller composed.

  app.get(
    `${base}/marketplace-kinds`,
    wrap(async (_req, res) => {
      const registered = new Set(orchestrator.listMarketplaceKinds());
      res.json({ kinds: MARKETPLACE_KINDS.map((kind) => ({ kind, registered: registered.has(kind) })) });
    }),
  );

  app.get(
    `${base}/marketplaces`,
    wrap(async (_req, res) => {
      res.json({
        marketplaces: orchestrator.marketplaces.list(companyId),
        installs: orchestrator.marketplaceInstalls(companyId),
      });
    }),
  );

  app.post(
    `${base}/marketplaces`,
    wrap(async (req, res) => {
      const input = createMarketplaceSchema.parse(req.body ?? {});
      const marketplace = orchestrator.marketplaces.create({ companyId, ...input });
      broadcast("crew_marketplace_changed", { marketplaceId: marketplace.id });
      res.status(201).json({ marketplace });
    }),
  );

  app.patch(
    `${base}/marketplaces/:id`,
    wrap(async (req, res) => {
      const existing = orchestrator.marketplaces.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found", message: "Marketplace not found" });
        return;
      }
      const patch = updateMarketplaceSchema.parse(req.body ?? {});
      const marketplace = orchestrator.marketplaces.update(existing.id, patch, {
        actorType: "owner",
        actorId: "ceo",
      });
      broadcast("crew_marketplace_changed", { marketplaceId: existing.id });
      res.json({ marketplace });
    }),
  );

  app.delete(
    `${base}/marketplaces/:id`,
    wrap(async (req, res) => {
      const existing = orchestrator.marketplaces.get(param(req, "id"));
      if (!existing || existing.company_id !== companyId) {
        res.status(404).json({ error: "not_found", message: "Marketplace not found" });
        return;
      }
      orchestrator.marketplaces.delete(existing.id, { actorType: "owner", actorId: "ceo" });
      broadcast("crew_marketplace_changed", { marketplaceId: existing.id, deleted: true });
      res.json({ ok: true });
    }),
  );

  app.get(
    `${base}/marketplaces/:id/entries`,
    wrap(async (req, res) => {
      const entries = await orchestrator.browseMarketplace(companyId, param(req, "id"));
      res.json({ entries, marketplace: orchestrator.marketplaces.get(param(req, "id")) });
    }),
  );

  app.post(
    `${base}/marketplaces/:id/install`,
    wrap(async (req, res) => {
      const input = installEntrySchema.parse(req.body ?? {});
      const { install, result } = await orchestrator.installFromMarketplace(
        companyId,
        param(req, "id"),
        input.entryId,
        { env: input.env, headers: input.headers, nameOverride: input.name },
        { actorType: "owner", actorId: "ceo" },
      );
      broadcast("crew_marketplace_changed", { marketplaceId: param(req, "id"), installed: result.name });
      res.status(201).json({ install, result });
    }),
  );

  app.delete(
    `${base}/marketplace-installs/:entryType/:name`,
    wrap(async (req, res) => {
      const entryType = param(req, "entryType");
      if (entryType !== "mcp" && entryType !== "skill") {
        res.status(400).json({ error: "invalid_request", message: 'entryType must be "mcp" or "skill"' });
        return;
      }
      const removed = await orchestrator.uninstallFromMarketplace(companyId, entryType, param(req, "name"), {
        actorType: "owner",
        actorId: "ceo",
      });
      if (!removed) {
        res.status(404).json({ error: "not_found", message: "Nothing installed under that name" });
        return;
      }
      broadcast("crew_marketplace_changed", { uninstalled: param(req, "name") });
      res.json({ ok: true });
    }),
  );

  return { orchestrator, companyId };
}
