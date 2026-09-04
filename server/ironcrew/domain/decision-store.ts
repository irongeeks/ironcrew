/**
 * IronCrew — decision log.
 *
 * Distinct from the audit trail: the audit chain is a technical record of
 * every write ("who did what, when"); a decision is a business-level record
 * of a judgement call and its reasoning ("why we chose X over Y"), meant to
 * be read back later without wading through the full audit stream. Recorded
 * automatically wherever the CEO decides something the system already
 * tracks (an approval), and available for an agent or the CEO to record
 * directly for anything else worth remembering.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent } from "./audit.ts";

export interface DecisionRow {
  id: string;
  company_id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  decided_by: string;
  created_at: number;
}

export interface CreateDecisionInput {
  companyId: string;
  title: string;
  decision: string;
  context?: string;
  rationale?: string;
  decidedBy: string;
  projectId?: string | null;
  taskId?: string | null;
}

export class DecisionStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateDecisionInput): DecisionRow {
    const id = newId("dec");
    this.db
      .prepare(
        `INSERT INTO crew_decisions (id, company_id, project_id, task_id, title, context, decision, rationale, decided_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.projectId ?? null,
        input.taskId ?? null,
        input.title,
        input.context ?? "",
        input.decision,
        input.rationale ?? "",
        input.decidedBy,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: "owner",
      actorId: input.decidedBy,
      action: "decision.recorded",
      entityType: "decision",
      entityId: id,
      taskId: input.taskId ?? null,
      details: { title: input.title, decision: input.decision },
    });

    return this.get(id)!;
  }

  get(id: string): DecisionRow | null {
    return oneRow<DecisionRow>(this.db.prepare("SELECT * FROM crew_decisions WHERE id = ?"), id);
  }

  list(companyId: string, opts: { projectId?: string; taskId?: string; limit?: number } = {}): DecisionRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.taskId) {
      clauses.push("task_id = ?");
      params.push(opts.taskId);
    }
    params.push(limit);
    // created_at has whole-second resolution (unixepoch()*1000); rowid (SQLite's
    // implicit, monotonically-increasing insert order) breaks same-second ties.
    return allRows<DecisionRow>(
      this.db.prepare(
        `SELECT * FROM crew_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ),
      ...params,
    );
  }
}
