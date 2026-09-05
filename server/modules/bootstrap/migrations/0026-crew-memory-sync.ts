import type { Migration } from "./migration-types.ts";

/** Reference-only durable outbox. Memory bodies remain in the local vault. */
export const migration: Migration = {
  version: 26,
  description: "Persistent optional semantic memory synchronization",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS crew_memory_sync (
      company_id TEXT NOT NULL REFERENCES crew_companies(id),
      external_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('write','delete')),
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','synced','failed')),
      revision INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY(company_id, external_id)
    );`);
  },
};
