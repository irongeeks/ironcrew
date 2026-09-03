/**
 * Iron Command OS — REST surface.
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

export interface IronCommandApiOptions {
  db: DatabaseSync;
  broadcast?: Broadcast;
  /** Company slug this installation operates. */
  companySlug?: string;
  companyName?: string;
  orchestrator?: CompanyOrchestrator;
}

export interface IronCommandApi {
  orchestrator: CompanyOrchestrator;
  companyId: string;
}

export function registerIronCommandRoutes(app: Express, opts: IronCommandApiOptions): IronCommandApi {
  const { db } = opts;
  const broadcast: Broadcast = opts.broadcast ?? (() => {});

  const orchestrator = opts.orchestrator ?? new CompanyOrchestrator(db);
  if (!opts.orchestrator) orchestrator.registerRuntime(new MockRuntime());

  const companyId = orchestrator.seedCompany({
    name: opts.companyName ?? "Iron Command",
    slug: opts.companySlug ?? "iron-command",
  });

  const base = "/api/ic";

  // --- company / org ------------------------------------------------------

  app.get(
    `${base}/company`,
    wrap((_req, res) => {
      const company = db.prepare("SELECT * FROM ic_companies WHERE id = ?").get(companyId);
      const departments = db
        .prepare("SELECT * FROM ic_departments WHERE company_id = ? ORDER BY sort_order")
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
    runtimeProfile: a.runtime_profile,
    runtimeProvider: a.runtime_provider,
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
      broadcast("ic_agent_changed", { agentId: agent.id, runtimeProvider: agent.runtime_provider });
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
      broadcast("ic_chat_message", { conversationId: result.conversationId, reply: result.reply });
      if (result.task) broadcast("ic_task_changed", { taskId: result.task.id, status: result.task.status });
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
        onEvent: (e: RunEvent) => broadcast("ic_run_event", e),
      });
      if (!result) {
        res.json({ executed: false, reason: "nothing claimable" });
        return;
      }
      broadcast("ic_task_changed", { taskId: result.task.id, status: result.task.status });
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
      broadcast("ic_task_changed", { taskId: task.id, status: task.status });
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
      broadcast("ic_task_changed", { taskId: task.id, status: task.status });
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
      broadcast("ic_task_changed", { taskId: task.id, status: task.status });
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
      broadcast("ic_task_changed", { taskId: task.id, status: task.status });
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
      broadcast("ic_task_changed", { taskId: task.id, status: task.status });
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
      broadcast("ic_goal_changed", { goalId: goal.id });
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
      broadcast("ic_goal_changed", { goalId: existing.id });
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
      broadcast("ic_goal_changed", { goalId: existing.id, status });
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
      broadcast("ic_goal_changed", { goalId: existing.id });
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
      broadcast("ic_project_changed", { projectId: project.id });
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
      broadcast("ic_project_changed", { projectId: existing.id });
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
      broadcast("ic_project_changed", { projectId: existing.id, status });
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
      broadcast("ic_project_changed", { projectId: project.id });
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
      broadcast("ic_project_changed", { projectId: existing.project_id });
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
      broadcast("ic_project_changed", { projectId: existing.project_id, status });
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
      const approval = orchestrator.approvals.decide(param(req, "id"), decision, "ceo", reason ?? "");
      if (!approval) {
        res.status(409).json({ error: "already_decided", message: "This approval is no longer pending." });
        return;
      }
      broadcast("ic_approval_decided", { approvalId: approval.id, status: approval.status });
      res.json({ approval });
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
        .prepare("SELECT status, COUNT(*) AS n FROM ic_tasks WHERE company_id = ? GROUP BY status")
        .all(companyId) as unknown as Array<{ status: string; n: number }>;
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
      const agents = orchestrator.listAgents(companyId);
      const agentStates = agents.map((a) => orchestrator.agentStatus(companyId, a.id));

      res.json({
        // Every figure names its source and the moment it was read, so the UI
        // never shows a number without provenance.
        generatedAt: Date.now(),
        source: "ic_tasks / ic_agents / ic_approvals / ic_cost_events (live)",
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

  return { orchestrator, companyId };
}
