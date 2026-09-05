import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 32,
  description: "Persisted EA project plans and explicit owner review before delegation",
  up(db) {
    db.exec(`CREATE TABLE crew_project_plans (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES crew_companies(id),
      project_id TEXT NOT NULL REFERENCES crew_projects(id),
      task_id TEXT NOT NULL UNIQUE REFERENCES crew_tasks(id),
      run_id TEXT REFERENCES crew_runs(id),
      status TEXT NOT NULL CHECK(status IN ('planning','review','approved','rejected','failed')),
      plan_json TEXT, error TEXT, reviewed_by TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX idx_crew_project_plans_company ON crew_project_plans(company_id,updated_at);`);
  },
};
