// server/modules/bootstrap/migrations/0012-crew-agent-run-lock.ts
//
// IronCrew — one agent, one run at a time.
//
// `crew_tasks` already prevents two workers claiming the same *task*: the
// claim is a compare-and-set whose condition lives in the WHERE clause, so
// the database decides, and an expired lease is reclaimable. What nothing
// prevented is the other collision: two *different* tasks dispatched to the
// same agent at the same moment.
//
// That matters beyond tidiness. An agent holds a workspace, a CLI session and
// a budget. Two concurrent runs share all three: they interleave writes in one
// working tree, and each passes the pre-dispatch budget gate without seeing
// the other's spend — so a limit checked twice concurrently is a limit
// enforced once.
//
// The lock lives on the agent row rather than in a table of its own, matching
// where the task lock lives, so the two are read and reasoned about the same
// way:
//
//   run_lock_run_id      the run that holds it — release is guarded on this
//                        id, so a late reaper cannot clear a fresh owner's
//                        lock (the rule TaskStore.releaseLock already uses)
//   run_lock_expires_at  a lease, not a lock. A crashed run must not park an
//                        agent forever, so an expired lease is reclaimable
//                        by the next claimant.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
ALTER TABLE crew_agents ADD COLUMN run_lock_run_id TEXT;
ALTER TABLE crew_agents ADD COLUMN run_lock_expires_at INTEGER;

-- The sweep for reclaimable leases orders by expiry, so index that pair.
CREATE INDEX IF NOT EXISTS idx_crew_agents_run_lock
  ON crew_agents(run_lock_run_id, run_lock_expires_at);
`;

export const migration: Migration = {
  version: 12,
  description: "per-agent run lease, so one agent never has two runs in flight",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 12 }, "agent run lock added");
  },
};
