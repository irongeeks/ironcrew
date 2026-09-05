import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 36,
  description: "Versioned company operating configuration and meeting capacity leases",
  up(db) {
    db.exec(`
      CREATE TABLE crew_company_configuration_revisions (
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        configuration_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL,
        audit_event_id TEXT NOT NULL REFERENCES crew_audit_events(id),
        PRIMARY KEY(company_id, revision)
      );
      CREATE TABLE crew_company_execution_leases (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX crew_company_execution_leases_scope ON crew_company_execution_leases(company_id, expires_at);
    `);
  },
};
