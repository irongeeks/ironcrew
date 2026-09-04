// server/modules/bootstrap/migrations/0021-crew-routines.ts
//
// IronCrew — recurring work that leaves a trace.
//
// Phase 3's line about this is the whole specification: "Routines and
// heartbeats — every routine produces a visible task or run, never an
// invisible background action."
//
// That constraint is the point. A scheduler that quietly does things is a
// scheduler nobody can audit, budget or stop: the owner cannot see what ran,
// the cost engine never learns about the spend, and the first evidence that a
// routine misfires is usually the damage. So a routine here does not *do*
// anything. It creates a task, exactly as if the owner had asked for it, and
// from that moment the work is ordinary work — visible on the board, subject
// to the same approval gates, the same budgets and the same agent locks.
//
// WHY `next_run_at` IS A COLUMN AND NOT A COMPUTATION
//
// Because the answer has to survive a restart and has to be claimable. A
// scheduler that recomputed "is it due?" from an interval and a last-run
// timestamp would fire twice if two drains overlapped, and would silently
// skip a window it slept through. A stored `next_run_at`, advanced under the
// same compare-and-set the run queue uses, gives exactly-once-per-window.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No cron expression. An interval in minutes covers "every four hours" and
// "every Monday" is a scheduling problem this product does not have yet;
// adding a cron parser now would be a dependency and a parsing surface for a
// feature nobody asked for. `interval_minutes` is honest about what it does.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_routines (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  name             TEXT NOT NULL,
  -- What the routine asks for, in the owner's words. It becomes the task's
  -- description verbatim, because a routine is the owner asking on a timer.
  instruction      TEXT NOT NULL,

  -- Optional routing. Without them the EA triages the task exactly as it
  -- triages anything the owner types.
  agent_id         TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  project_id       TEXT REFERENCES crew_projects(id) ON DELETE SET NULL,

  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 1),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),

  -- The scheduling state. See the header: stored, not recomputed.
  next_run_at      INTEGER NOT NULL,
  last_run_at      INTEGER,
  -- The task the last firing produced, so "what did this routine actually do"
  -- is one click and not an investigation.
  last_task_id     TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  run_count        INTEGER NOT NULL DEFAULT 0,

  created_at       INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crew_routines_due
  ON crew_routines(company_id, enabled, next_run_at);
`;

export const migration: Migration = {
  version: 21,
  description: "routines: recurring work that becomes a visible task, never an invisible background action",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 21 }, "routine table ensured");
  },
};
