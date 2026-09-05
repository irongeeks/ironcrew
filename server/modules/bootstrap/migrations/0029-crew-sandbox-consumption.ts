import type { Migration } from "./migration-types.ts";

/** One owner-approved sandbox window authorizes at most one persisted run. */
export const migration: Migration = {
  version: 29,
  description: "Persist single-run sandbox grant consumption",
  up(db) {
    db.exec("ALTER TABLE crew_sandbox_grants ADD COLUMN consumed_run_id TEXT REFERENCES crew_runs(id)");
    db.exec("ALTER TABLE crew_sandbox_grants ADD COLUMN consumed_at INTEGER");
  },
};
