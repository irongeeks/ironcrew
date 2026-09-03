/**
 * Iron Command OS — project and milestone repository.
 *
 * A project is the unit of planning between a strategic goal and the tasks
 * that actually get executed (goal -> project -> task). Milestones are dated
 * checkpoints within a project's timeline — not themselves executable work,
 * so they live in ic_milestones rather than ic_tasks (see the migration's
 * own comment for why).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import {
  assertMilestoneTransition,
  assertProjectTransition,
  type MilestoneStatus,
  type ProjectStatus,
} from "./project-state.ts";

export interface ProjectRow {
  id: string;
  company_id: string;
  goal_id: string | null;
  key: string;
  title: string;
  summary: string;
  status: ProjectStatus;
  owner_agent_id: string | null;
  workspace_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface MilestoneRow {
  id: string;
  company_id: string;
  project_id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  due_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CreateProjectInput {
  companyId: string;
  title: string;
  /** Short, URL-safe identifier, unique per company. Derived from the title when omitted. */
  key?: string;
  summary?: string;
  goalId?: string | null;
  status?: ProjectStatus;
  ownerAgentId?: string | null;
  workspacePath?: string | null;
  actorType?: ActorType;
  actorId?: string;
}

export interface CreateMilestoneInput {
  companyId: string;
  projectId: string;
  title: string;
  description?: string;
  dueAt?: number | null;
  sortOrder?: number;
  actorType?: ActorType;
  actorId?: string;
}

export class ProjectMutationError extends Error {}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics (U+0300-U+036F) left behind by NFKD
    // normalization, so "Übersicht" -> "ubersicht" rather than dropping the
    // whole word to dashes.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}

export class ProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  // --- projects -------------------------------------------------------------

  create(input: CreateProjectInput): ProjectRow {
    if (input.goalId) {
      const goal = oneRow<{ company_id: string }>(
        this.db.prepare("SELECT company_id FROM ic_goals WHERE id = ?"),
        input.goalId,
      );
      if (!goal) throw new ProjectMutationError(`Goal "${input.goalId}" does not exist.`);
      if (goal.company_id !== input.companyId) {
        throw new ProjectMutationError("A project's goal must belong to the same company.");
      }
    }
    if (input.ownerAgentId) {
      const agent = oneRow<{ company_id: string }>(
        this.db.prepare("SELECT company_id FROM ic_agents WHERE id = ?"),
        input.ownerAgentId,
      );
      if (!agent) throw new ProjectMutationError(`Agent "${input.ownerAgentId}" does not exist.`);
      if (agent.company_id !== input.companyId) {
        throw new ProjectMutationError("A project's owner must belong to the same company.");
      }
    }

    const id = newId("prj");
    const status: ProjectStatus = input.status ?? "active";
    const baseKey = input.key ? slugify(input.key) : slugify(input.title);
    let key = baseKey;
    // Retry on the UNIQUE (company_id, key) constraint rather than
    // pre-checking-then-inserting, which would race under concurrent writers.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        this.db
          .prepare(
            `INSERT INTO ic_projects (id, company_id, goal_id, key, title, summary, status, owner_agent_id, workspace_path)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.companyId,
            input.goalId ?? null,
            key,
            input.title,
            input.summary ?? "",
            status,
            input.ownerAgentId ?? null,
            input.workspacePath ?? null,
          );
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed/.test(message) || attempt === 19) throw err;
        key = `${baseKey}-${attempt + 2}`;
      }
    }

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "project.created",
      entityType: "project",
      entityId: id,
      details: { title: input.title, key, goalId: input.goalId ?? null },
    });

    return this.get(id)!;
  }

  get(id: string): ProjectRow | null {
    return oneRow<ProjectRow>(this.db.prepare("SELECT * FROM ic_projects WHERE id = ?"), id);
  }

  getByKey(companyId: string, key: string): ProjectRow | null {
    return oneRow<ProjectRow>(
      this.db.prepare("SELECT * FROM ic_projects WHERE company_id = ? AND key = ?"),
      companyId,
      key,
    );
  }

  list(companyId: string, opts: { status?: ProjectStatus; goalId?: string } = {}): ProjectRow[] {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.goalId) {
      clauses.push("goal_id = ?");
      params.push(opts.goalId);
    }
    return allRows<ProjectRow>(
      this.db.prepare(`SELECT * FROM ic_projects WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`),
      ...params,
    );
  }

  update(
    projectId: string,
    patch: {
      title?: string;
      summary?: string;
      goalId?: string | null;
      ownerAgentId?: string | null;
      workspacePath?: string | null;
    },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): ProjectRow | null {
    const project = this.get(projectId);
    if (!project) return null;

    if (patch.goalId) {
      const goal = oneRow<{ company_id: string }>(
        this.db.prepare("SELECT company_id FROM ic_goals WHERE id = ?"),
        patch.goalId,
      );
      if (!goal || goal.company_id !== project.company_id) {
        throw new ProjectMutationError(`Goal "${patch.goalId}" is not valid for this project.`);
      }
    }

    this.db
      .prepare(
        `UPDATE ic_projects
            SET title = COALESCE(?, title),
                summary = COALESCE(?, summary),
                goal_id = CASE WHEN ? THEN ? ELSE goal_id END,
                owner_agent_id = CASE WHEN ? THEN ? ELSE owner_agent_id END,
                workspace_path = CASE WHEN ? THEN ? ELSE workspace_path END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.summary ?? null,
        "goalId" in patch ? 1 : 0,
        patch.goalId ?? null,
        "ownerAgentId" in patch ? 1 : 0,
        patch.ownerAgentId ?? null,
        "workspacePath" in patch ? 1 : 0,
        patch.workspacePath ?? null,
        Date.now(),
        projectId,
      );

    appendAuditEvent(this.db, {
      companyId: project.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "project.updated",
      entityType: "project",
      entityId: projectId,
      details: patch as Record<string, unknown>,
    });
    return this.get(projectId);
  }

  setStatus(
    projectId: string,
    status: ProjectStatus,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): ProjectRow | null {
    const project = this.get(projectId);
    if (!project) return null;
    assertProjectTransition(project.status, status);

    this.db
      .prepare("UPDATE ic_projects SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), projectId);

    appendAuditEvent(this.db, {
      companyId: project.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "project.status_changed",
      entityType: "project",
      entityId: projectId,
      details: { from: project.status, to: status },
    });
    return this.get(projectId);
  }

  // --- milestones -------------------------------------------------------------

  addMilestone(input: CreateMilestoneInput): MilestoneRow {
    const project = this.get(input.projectId);
    if (!project) throw new ProjectMutationError(`Project "${input.projectId}" does not exist.`);
    if (project.company_id !== input.companyId) {
      throw new ProjectMutationError("A milestone's project must belong to the same company.");
    }

    const id = newId("mile");
    this.db
      .prepare(
        `INSERT INTO ic_milestones (id, company_id, project_id, title, description, due_at, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.title,
        input.description ?? "",
        input.dueAt ?? null,
        input.sortOrder ?? 0,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "milestone.created",
      entityType: "milestone",
      entityId: id,
      details: { projectId: input.projectId, title: input.title },
    });

    return this.getMilestone(id)!;
  }

  getMilestone(id: string): MilestoneRow | null {
    return oneRow<MilestoneRow>(this.db.prepare("SELECT * FROM ic_milestones WHERE id = ?"), id);
  }

  listMilestones(projectId: string, opts: { status?: MilestoneStatus } = {}): MilestoneRow[] {
    if (opts.status) {
      return allRows<MilestoneRow>(
        this.db.prepare(
          "SELECT * FROM ic_milestones WHERE project_id = ? AND status = ? ORDER BY sort_order ASC, due_at ASC",
        ),
        projectId,
        opts.status,
      );
    }
    return allRows<MilestoneRow>(
      this.db.prepare("SELECT * FROM ic_milestones WHERE project_id = ? ORDER BY sort_order ASC, due_at ASC"),
      projectId,
    );
  }

  updateMilestone(
    milestoneId: string,
    patch: { title?: string; description?: string; dueAt?: number | null; sortOrder?: number },
  ): MilestoneRow | null {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) return null;
    this.db
      .prepare(
        `UPDATE ic_milestones
            SET title = COALESCE(?, title),
                description = COALESCE(?, description),
                due_at = CASE WHEN ? THEN ? ELSE due_at END,
                sort_order = COALESCE(?, sort_order),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.description ?? null,
        "dueAt" in patch ? 1 : 0,
        patch.dueAt ?? null,
        patch.sortOrder ?? null,
        Date.now(),
        milestoneId,
      );
    return this.getMilestone(milestoneId);
  }

  setMilestoneStatus(
    milestoneId: string,
    status: MilestoneStatus,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): MilestoneRow | null {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) return null;
    assertMilestoneTransition(milestone.status, status);

    const now = Date.now();
    const completedAt = status === "done" ? now : null;
    this.db
      .prepare(
        `UPDATE ic_milestones
            SET status = ?, completed_at = COALESCE(?, completed_at), updated_at = ?
          WHERE id = ?`,
      )
      .run(status, completedAt, now, milestoneId);

    appendAuditEvent(this.db, {
      companyId: milestone.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "milestone.status_changed",
      entityType: "milestone",
      entityId: milestoneId,
      details: { from: milestone.status, to: status },
    });
    return this.getMilestone(milestoneId);
  }
}
