import type { Migration } from "./migration-types.ts";

/** Resume may reuse a provider session only within the original workspace. */
export const migration: Migration = {
  version: 27,
  description: "Persist the workspace boundary for runtime session continuation",
  up(db) {
    db.exec("ALTER TABLE crew_runs ADD COLUMN workspace_path TEXT");
  },
};
