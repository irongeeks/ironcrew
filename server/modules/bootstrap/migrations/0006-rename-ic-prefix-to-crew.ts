// server/modules/bootstrap/migrations/0006-rename-ic-prefix-to-crew.ts
//
// IronCrew — rename the "ic_" (Iron Command) table/index prefix to "crew_".
//
// A fresh install never sees this migration do anything: migrations 0002-0005
// already create every table under its "crew_" name directly, so each rename
// below is a guarded no-op there (old name absent). It only does real work on
// a database that ran this project before the IronCrew rename, where the
// tables still physically carry their original "ic_" names — SQLite doesn't
// rename anything just because the application's source code did.
//
// Indexes have no "RENAME" in SQLite, so those are dropped-and-recreated
// under their new name instead; that runs unconditionally and is cheap and
// idempotent (IF EXISTS / IF NOT EXISTS on both sides) either way, since by
// the time it runs the table rename above has already guaranteed every table
// is "crew_"-named. The column list is repeated here rather than imported
// from 0002-0005 so this migration reads standalone and stays correct even
// if a later migration changes one of those indexes going forward.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const TABLE_RENAMES: Array<[string, string]> = [
  ["ic_agents", "crew_agents"],
  ["ic_approvals", "crew_approvals"],
  ["ic_attachments", "crew_attachments"],
  ["ic_audit_events", "crew_audit_events"],
  ["ic_budgets", "crew_budgets"],
  ["ic_companies", "crew_companies"],
  ["ic_conversations", "crew_conversations"],
  ["ic_cost_events", "crew_cost_events"],
  ["ic_decisions", "crew_decisions"],
  ["ic_departments", "crew_departments"],
  ["ic_goals", "crew_goals"],
  ["ic_memory_refs", "crew_memory_refs"],
  ["ic_messages", "crew_messages"],
  ["ic_milestones", "crew_milestones"],
  ["ic_notifications", "crew_notifications"],
  ["ic_projects", "crew_projects"],
  ["ic_run_events", "crew_run_events"],
  ["ic_runs", "crew_runs"],
  ["ic_sandbox_grants", "crew_sandbox_grants"],
  ["ic_secrets", "crew_secrets"],
  ["ic_task_dependencies", "crew_task_dependencies"],
  ["ic_tasks", "crew_tasks"],
];

// [new index name, "<new table>(<columns>)"] — the old index name is always
// "idx_ic_" + this name's "idx_crew_" suffix.
const INDEX_DEFS: Array<[string, string]> = [
  ["idx_crew_agents_company", "crew_agents(company_id, status)"],
  ["idx_crew_agents_department", "crew_agents(company_id, department_id)"],
  ["idx_crew_goals_company", "crew_goals(company_id, status)"],
  ["idx_crew_projects_company", "crew_projects(company_id, status)"],
  ["idx_crew_tasks_company_status", "crew_tasks(company_id, status)"],
  ["idx_crew_tasks_project", "crew_tasks(company_id, project_id, status)"],
  ["idx_crew_tasks_agent", "crew_tasks(company_id, assigned_agent_id, status)"],
  ["idx_crew_tasks_lock", "crew_tasks(status, lock_expires_at)"],
  ["idx_crew_tasks_parent", "crew_tasks(parent_task_id)"],
  ["idx_crew_task_deps_task", "crew_task_dependencies(task_id)"],
  ["idx_crew_task_deps_dep", "crew_task_dependencies(depends_on_id)"],
  ["idx_crew_runs_task", "crew_runs(company_id, task_id, created_at)"],
  ["idx_crew_runs_status", "crew_runs(company_id, status)"],
  ["idx_crew_runs_heartbeat", "crew_runs(status, heartbeat_at)"],
  ["idx_crew_run_events_run", "crew_run_events(run_id, seq)"],
  ["idx_crew_run_events_task", "crew_run_events(company_id, task_id, created_at)"],
  ["idx_crew_conversations_company", "crew_conversations(company_id, kind)"],
  ["idx_crew_messages_conversation", "crew_messages(conversation_id, created_at)"],
  ["idx_crew_approvals_company", "crew_approvals(company_id, status, created_at)"],
  ["idx_crew_approvals_task", "crew_approvals(task_id, status)"],
  ["idx_crew_decisions_company", "crew_decisions(company_id, created_at)"],
  ["idx_crew_budgets_company", "crew_budgets(company_id, active)"],
  ["idx_crew_cost_company_month", "crew_cost_events(company_id, window_month)"],
  ["idx_crew_cost_agent", "crew_cost_events(company_id, agent_id, window_month)"],
  ["idx_crew_cost_project", "crew_cost_events(company_id, project_id, window_month)"],
  ["idx_crew_grants_company", "crew_sandbox_grants(company_id, expires_at)"],
  ["idx_crew_audit_company", "crew_audit_events(company_id, created_at)"],
  ["idx_crew_audit_entity", "crew_audit_events(company_id, entity_type, entity_id)"],
  ["idx_crew_memory_company", "crew_memory_refs(company_id, kind)"],
  ["idx_crew_notifications_company", "crew_notifications(company_id, read_at, created_at)"],
  ["idx_crew_milestones_project", "crew_milestones(project_id, status)"],
  ["idx_crew_milestones_company", "crew_milestones(company_id, due_at)"],
  ["idx_crew_secrets_company", "crew_secrets(company_id, name)"],
  ["idx_crew_attachments_company", "crew_attachments(company_id, created_at)"],
  ["idx_crew_attachments_task", "crew_attachments(task_id)"],
  ["idx_crew_attachments_project", "crew_attachments(project_id)"],
];

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

export const migration: Migration = {
  version: 6,
  description: "rename the ic_ table/index prefix to crew_",
  up(db: DatabaseSync): void {
    let renamed = 0;
    for (const [oldName, newName] of TABLE_RENAMES) {
      if (tableExists(db, oldName) && !tableExists(db, newName)) {
        db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        renamed++;
      }
    }

    for (const [newIndexName, tableAndColumns] of INDEX_DEFS) {
      const oldIndexName = newIndexName.replace(/^idx_crew_/, "idx_ic_");
      db.exec(`DROP INDEX IF EXISTS ${oldIndexName}`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${newIndexName} ON ${tableAndColumns}`);
    }

    log.info({ version: 6, tablesRenamed: renamed }, "ic_ prefix renamed to crew_");
  },
};
