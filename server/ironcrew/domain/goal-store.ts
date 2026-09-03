/**
 * IronCrew — goal repository.
 *
 * Goals form a tree (`parent_id` self-reference), so a task or project can be
 * traced up to the strategic objective it ultimately serves. `ancestry()` is
 * what the run context builder (company.ts) reads to give an agent that
 * "why does this matter" context — see docs/ROADMAP.md Phase 2.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { assertGoalTransition, type GoalStatus } from "./goal-state.ts";

export interface GoalRow {
  id: string;
  company_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: GoalStatus;
  created_at: number;
}

export interface CreateGoalInput {
  companyId: string;
  title: string;
  description?: string;
  parentId?: string | null;
  status?: GoalStatus;
  actorType?: ActorType;
  actorId?: string;
}

export class GoalMutationError extends Error {}

export class GoalStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateGoalInput): GoalRow {
    if (input.parentId) {
      const parent = this.get(input.parentId);
      if (!parent) throw new GoalMutationError(`Parent goal "${input.parentId}" does not exist.`);
      if (parent.company_id !== input.companyId) {
        throw new GoalMutationError("A goal's parent must belong to the same company.");
      }
    }

    const id = newId("goal");
    const status: GoalStatus = input.status ?? "active";
    this.db
      .prepare(
        `INSERT INTO crew_goals (id, company_id, parent_id, title, description, status)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, input.companyId, input.parentId ?? null, input.title, input.description ?? "", status);

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "goal.created",
      entityType: "goal",
      entityId: id,
      details: { title: input.title, parentId: input.parentId ?? null },
    });

    return this.get(id)!;
  }

  get(id: string): GoalRow | null {
    return oneRow<GoalRow>(this.db.prepare("SELECT * FROM crew_goals WHERE id = ?"), id);
  }

  list(companyId: string, opts: { status?: GoalStatus; parentId?: string | null } = {}): GoalRow[] {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) {
        clauses.push("parent_id IS NULL");
      } else {
        clauses.push("parent_id = ?");
        params.push(opts.parentId);
      }
    }
    return allRows<GoalRow>(
      this.db.prepare(`SELECT * FROM crew_goals WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`),
      ...params,
    );
  }

  /** Direct children of a goal. */
  children(goalId: string): GoalRow[] {
    return allRows<GoalRow>(
      this.db.prepare("SELECT * FROM crew_goals WHERE parent_id = ? ORDER BY created_at ASC"),
      goalId,
    );
  }

  /**
   * The chain from the root goal down to (and including) `goalId`. Empty
   * array when the goal does not exist. This is what a context builder reads
   * to explain, in order, why a task ultimately matters.
   */
  ancestry(goalId: string): GoalRow[] {
    const chain: GoalRow[] = [];
    let current = this.get(goalId);
    const seen = new Set<string>();
    while (current) {
      // A malformed cycle (should be unreachable given reparent()'s guard)
      // must not hang this walk — stop rather than loop forever.
      if (seen.has(current.id)) break;
      seen.add(current.id);
      chain.unshift(current);
      current = current.parent_id ? this.get(current.parent_id) : null;
    }
    return chain;
  }

  update(
    goalId: string,
    patch: { title?: string; description?: string },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): GoalRow | null {
    const goal = this.get(goalId);
    if (!goal) return null;
    this.db
      .prepare("UPDATE crew_goals SET title = COALESCE(?, title), description = COALESCE(?, description) WHERE id = ?")
      .run(patch.title ?? null, patch.description ?? null, goalId);

    appendAuditEvent(this.db, {
      companyId: goal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "goal.updated",
      entityType: "goal",
      entityId: goalId,
      details: { title: patch.title, description: patch.description },
    });
    return this.get(goalId);
  }

  /**
   * Move a goal under a different parent (or to the top level with `null`).
   * Rejects a move that would make a goal its own descendant's parent,
   * mirroring TaskStore's cycle guard on dependency edges.
   */
  reparent(
    goalId: string,
    newParentId: string | null,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): GoalRow | null {
    const goal = this.get(goalId);
    if (!goal) return null;
    if (newParentId) {
      if (newParentId === goalId) throw new GoalMutationError("A goal cannot be its own parent.");
      const parent = this.get(newParentId);
      if (!parent) throw new GoalMutationError(`Parent goal "${newParentId}" does not exist.`);
      if (parent.company_id !== goal.company_id) {
        throw new GoalMutationError("A goal's parent must belong to the same company.");
      }
      if (this.ancestry(newParentId).some((a) => a.id === goalId)) {
        throw new GoalMutationError(`Moving "${goalId}" under "${newParentId}" would create a cycle.`);
      }
    }
    this.db.prepare("UPDATE crew_goals SET parent_id = ? WHERE id = ?").run(newParentId, goalId);

    appendAuditEvent(this.db, {
      companyId: goal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "goal.reparented",
      entityType: "goal",
      entityId: goalId,
      details: { from: goal.parent_id, to: newParentId },
    });
    return this.get(goalId);
  }

  setStatus(
    goalId: string,
    status: GoalStatus,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): GoalRow | null {
    const goal = this.get(goalId);
    if (!goal) return null;
    assertGoalTransition(goal.status, status);

    this.db.prepare("UPDATE crew_goals SET status = ? WHERE id = ?").run(status, goalId);

    appendAuditEvent(this.db, {
      companyId: goal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "goal.status_changed",
      entityType: "goal",
      entityId: goalId,
      details: { from: goal.status, to: status },
    });
    return this.get(goalId);
  }
}
