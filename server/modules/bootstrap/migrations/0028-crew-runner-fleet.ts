import type { Migration } from "./migration-types.ts";

/** Fleet credentials are hashes; enrollment is single-use and leases fence reconnects. */
export const migration: Migration = {
  version: 28,
  description: "Outbound runner enrollment, scoped fleet credentials and execution leases",
  up(db) {
    db.exec(`
      CREATE TABLE crew_fleet_workers (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crew_companies(id),
        label TEXT NOT NULL, workspace_root TEXT NOT NULL,
        runtime_types TEXT NOT NULL, project_ids TEXT NOT NULL,
        allow_unscoped INTEGER NOT NULL DEFAULT 0, max_concurrent INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER,
        credential_hash TEXT UNIQUE, previous_hash TEXT, previous_expires_at INTEGER,
        credential_expires_at INTEGER, generation INTEGER NOT NULL DEFAULT 0,
        connected INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
        runtimes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE INDEX crew_fleet_company ON crew_fleet_workers(company_id);
      CREATE TABLE crew_fleet_enrollments (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES crew_fleet_workers(id),
        token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
        consumed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE crew_fleet_leases (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES crew_fleet_workers(id),
        company_id TEXT NOT NULL, project_id TEXT, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','completed','lost','revoked')),
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE UNIQUE INDEX crew_fleet_task_claim ON crew_fleet_leases(company_id,task_id) WHERE state='active';
      CREATE INDEX crew_fleet_worker_lease ON crew_fleet_leases(worker_id,state);
    `);
  },
};
