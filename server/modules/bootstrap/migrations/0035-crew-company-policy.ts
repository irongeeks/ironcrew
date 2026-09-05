import type { Migration } from "./migration-types.ts";
export const migration: Migration = {
  version: 35,
  description: "Company-scoped immutable vendor-policy revisions",
  up(db) {
    db.exec(`
      CREATE TABLE crew_company_policy_revisions (
        company_id TEXT NOT NULL REFERENCES crew_companies(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        restrictions_json TEXT NOT NULL,
        baseline_fingerprint TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL,
        audit_event_id TEXT NOT NULL REFERENCES crew_audit_events(id),
        PRIMARY KEY(company_id, revision)
      );
    `);
  },
};
