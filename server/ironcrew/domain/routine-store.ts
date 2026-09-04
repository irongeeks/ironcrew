/**
 * IronCrew — recurring work that leaves a trace.
 *
 * A routine does not do anything. It creates a task, exactly as if the owner
 * had asked for it on that morning, and from there the work is ordinary work:
 * on the board, through the same approval gates, against the same budgets,
 * under the same agent locks.
 *
 * That is the whole design, and it is deliberate. A scheduler that quietly
 * performs actions is one nobody can audit, budget or stop — the owner cannot
 * see what ran, the cost engine never learns about the spend, and the first
 * evidence of a misfiring routine is usually the damage it did.
 *
 * `claimDue()` is the interesting method. It mirrors the run queue's claim
 * rather than inventing a third answer to the same question: the condition
 * sits in the WHERE clause and `next_run_at` is advanced in the same
 * statement, so two overlapping scheduler ticks cannot both fire one routine.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export interface RoutineRow {
  id: string;
  company_id: string;
  name: string;
  instruction: string;
  agent_id: string | null;
  project_id: string | null;
  interval_minutes: number;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_task_id: string | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

export class RoutineMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineMutationError";
  }
}

const COLUMNS = `id, company_id, name, instruction, agent_id, project_id, interval_minutes, enabled,
  next_run_at, last_run_at, last_task_id, run_count, created_at, updated_at`;

/** One day. Longer intervals are a calendar, not a routine. */
const MAX_INTERVAL_MINUTES = 60 * 24 * 31;

export interface RoutineInput {
  companyId: string;
  name: string;
  instruction: string;
  intervalMinutes: number;
  agentId?: string | null;
  projectId?: string | null;
  /** First firing. Defaults to one interval from now, not immediately. */
  startAt?: number;
  enabled?: boolean;
}

export class RoutineStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: RoutineInput, opts: { actorType?: ActorType; actorId?: string; now?: number } = {}): RoutineRow {
    const now = opts.now ?? Date.now();
    const name = input.name.trim();
    const instruction = input.instruction.trim();

    if (!name) throw new RoutineMutationError("Eine Routine braucht einen Namen.");
    if (!instruction) throw new RoutineMutationError("Eine Routine ohne Auftrag hätte nichts zu tun.");
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1) {
      throw new RoutineMutationError("Das Intervall muss mindestens eine Minute betragen.");
    }
    if (input.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new RoutineMutationError("Intervalle über einen Monat sind ein Kalender, keine Routine.");
    }
    if (this.byName(input.companyId, name)) {
      throw new RoutineMutationError(`Es gibt bereits eine Routine namens "${name}".`);
    }

    const id = newId("rtn");
    // One interval from now rather than immediately: creating a routine
    // should not fire it, or an operator adjusting an interval would start a
    // run every time they touched the form.
    const nextRunAt = input.startAt ?? now + input.intervalMinutes * 60_000;

    this.db
      .prepare(
        `INSERT INTO crew_routines
           (id, company_id, name, instruction, agent_id, project_id, interval_minutes, enabled, next_run_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        name,
        instruction,
        input.agentId ?? null,
        input.projectId ?? null,
        input.intervalMinutes,
        input.enabled === false ? 0 : 1,
        nextRunAt,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "routine.created",
      entityType: "routine",
      entityId: id,
      details: { name, intervalMinutes: input.intervalMinutes },
    });
    return this.get(id)!;
  }

  get(id: string): RoutineRow | null {
    return oneRow<RoutineRow>(this.db.prepare(`SELECT ${COLUMNS} FROM crew_routines WHERE id = ?`), id);
  }

  byName(companyId: string, name: string): RoutineRow | null {
    return oneRow<RoutineRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_routines WHERE company_id = ? AND name = ?`),
      companyId,
      name,
    );
  }

  list(companyId: string): RoutineRow[] {
    return allRows<RoutineRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_routines WHERE company_id = ? ORDER BY next_run_at`),
      companyId,
    );
  }

  update(
    id: string,
    patch: {
      name?: string;
      instruction?: string;
      intervalMinutes?: number;
      agentId?: string | null;
      projectId?: string | null;
    },
    opts: { actorType?: ActorType; actorId?: string; now?: number } = {},
  ): RoutineRow | null {
    const routine = this.get(id);
    if (!routine) return null;
    const now = opts.now ?? Date.now();

    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new RoutineMutationError("Eine Routine braucht einen Namen.");
      const clash = this.byName(routine.company_id, name);
      if (clash && clash.id !== id) throw new RoutineMutationError(`Es gibt bereits eine Routine namens "${name}".`);
      sets.push("name = ?");
      values.push(name);
    }
    if (patch.instruction !== undefined) {
      const instruction = patch.instruction.trim();
      if (!instruction) throw new RoutineMutationError("Eine Routine ohne Auftrag hätte nichts zu tun.");
      sets.push("instruction = ?");
      values.push(instruction);
    }
    if (patch.intervalMinutes !== undefined) {
      if (!Number.isInteger(patch.intervalMinutes) || patch.intervalMinutes < 1) {
        throw new RoutineMutationError("Das Intervall muss mindestens eine Minute betragen.");
      }
      if (patch.intervalMinutes > MAX_INTERVAL_MINUTES) {
        throw new RoutineMutationError("Intervalle über einen Monat sind ein Kalender, keine Routine.");
      }
      sets.push("interval_minutes = ?", "next_run_at = ?");
      // A changed interval re-bases the next firing, so shortening it does
      // not leave the routine waiting out the old, longer one.
      values.push(patch.intervalMinutes, now + patch.intervalMinutes * 60_000);
    }
    if (patch.agentId !== undefined) {
      sets.push("agent_id = ?");
      values.push(patch.agentId);
    }
    if (patch.projectId !== undefined) {
      sets.push("project_id = ?");
      values.push(patch.projectId);
    }
    if (sets.length === 0) return routine;

    sets.push("updated_at = ?");
    values.push(now, id);
    this.db.prepare(`UPDATE crew_routines SET ${sets.join(", ")} WHERE id = ?`).run(...values);

    appendAuditEvent(this.db, {
      companyId: routine.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "routine.updated",
      entityType: "routine",
      entityId: id,
      details: { fields: Object.keys(patch) },
    });
    return this.get(id);
  }

  setEnabled(
    id: string,
    enabled: boolean,
    opts: { actorType?: ActorType; actorId?: string; now?: number } = {},
  ): RoutineRow | null {
    const routine = this.get(id);
    if (!routine) return null;
    const now = opts.now ?? Date.now();

    // Re-enabling re-bases the schedule. Without this a routine paused for a
    // week would fire the moment it came back, which is never what pausing
    // meant.
    const nextRunAt = enabled ? now + routine.interval_minutes * 60_000 : routine.next_run_at;
    this.db
      .prepare("UPDATE crew_routines SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nextRunAt, now, id);

    appendAuditEvent(this.db, {
      companyId: routine.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: enabled ? "routine.enabled" : "routine.disabled",
      entityType: "routine",
      entityId: id,
      details: { name: routine.name },
    });
    return this.get(id);
  }

  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const routine = this.get(id);
    if (!routine) return false;
    this.db.prepare("DELETE FROM crew_routines WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: routine.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "routine.deleted",
      entityType: "routine",
      entityId: id,
      details: { name: routine.name, runCount: routine.run_count },
    });
    return true;
  }

  /**
   * Claims one routine that is due, advancing its schedule in the same
   * statement.
   *
   * The advance is part of the claim, not a follow-up write, so two
   * overlapping scheduler ticks cannot both fire the same routine — the
   * second finds `next_run_at` already in the future. Same shape as the run
   * queue's claim and the agent lock: the database decides.
   */
  claimDue(companyId: string, now = Date.now()): RoutineRow | null {
    const candidate = oneRow<{ id: string; next_run_at: number }>(
      this.db.prepare(
        `SELECT id, next_run_at FROM crew_routines
          WHERE company_id = ? AND enabled = 1 AND next_run_at <= ?
          ORDER BY next_run_at LIMIT 1`,
      ),
      companyId,
      now,
    );
    if (!candidate) return null;

    const routine = this.get(candidate.id)!;
    const result = this.db
      .prepare(
        `UPDATE crew_routines
            SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1, updated_at = ?
          WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
      )
      .run(now + routine.interval_minutes * 60_000, now, now, candidate.id, candidate.next_run_at);

    // Lost the race to another tick: not an error, just nothing to do.
    if (Number(result.changes) !== 1) return null;
    return this.get(candidate.id);
  }

  /** Records which task a firing produced, so the routine can be traced to its work. */
  recordTask(id: string, taskId: string): RoutineRow | null {
    this.db.prepare("UPDATE crew_routines SET last_task_id = ? WHERE id = ?").run(taskId, id);
    return this.get(id);
  }
}
