// server/modules/bootstrap/migrations/0003-crew-milestones.ts
//
// IronCrew Phase 2 — project milestones.
//
// Additive: a milestone is a dated checkpoint within a project's timeline
// (a project is planned in these terms; a milestone is not itself a unit of
// execution the way crew_tasks is). Kept as its own table rather than reusing
// crew_tasks because a milestone has no assignee, no run, no acceptance
// criteria and no execution lock — conflating the two would mean every task
// query has to filter out non-work rows.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_milestones (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES crew_projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','missed','cancelled')),
  due_at        INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crew_milestones_project ON crew_milestones(project_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_milestones_company ON crew_milestones(company_id, due_at);
`;

export const migration: Migration = {
  version: 3,
  description: "ironcrew project milestones",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 3 }, "ironcrew milestones table ensured");
  },
};
