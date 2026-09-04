// server/modules/bootstrap/migrations/0016-crew-run-requests.ts
//
// IronCrew — the queue between "this should run" and "this is running".
//
// Until now those two were the same moment. A task became `ready` and then
// waited for someone to call POST /tasks/execute-next; the intent to run
// existed only as a task status plus the hope that a caller would come along.
// That was tolerable while the only ingress was a human typing into the
// Command Center, because the human pressing the button *was* the scheduler.
//
// It stopped being tolerable when mail and chat became ingresses. A message
// arriving at three in the morning creates a task that nothing will pick up,
// and the agent-start lock made the gap visible: a task dispatched while its
// agent is busy is put back to `ready` and forgotten again.
//
// So the intent gets a row of its own.
//
// WHY NOT JUST POLL THE TASK TABLE
//
// A task status says what a task *is*, not how often we have tried to run it,
// when we may try next, or which attempt failed and why. Overloading `ready`
// with all of that would mean either extra columns on crew_tasks that only
// the scheduler understands, or a scheduler that cannot back off, cannot stop
// after N attempts, and re-tries a permanently broken task forever at full
// speed. Retry state belongs to the attempt, not to the work.
//
// ONE LIVE REQUEST PER TASK, AS A SCHEMA GUARANTEE
//
// The partial unique index below is the important line in this file. Two
// ingresses can easily ask for the same task at once — a mail poll and a
// manual retry, say — and the resulting double run would be exactly the
// collision the agent lock exists to prevent, one layer earlier. A convention
// would drift; an index cannot.
//
// Finished rows are deliberately outside the index, so a task can be re-run
// after its first request completed. History is kept: a failed attempt is
// evidence, and deleting it would hide the reason someone is asking why
// nothing happened.
//
// THE LEASE IS THE SAME LEASE AS EVERYWHERE ELSE
//
// Claiming mirrors TaskStore.claim() and AgentLockStore.acquire(): the
// condition sits in the WHERE clause so the database decides, and the hold is
// a lease with an expiry rather than a lock, so a drain that crashes mid-run
// does not strand the request forever. Three places, one shape — a fourth
// answer to the same question is how subtle bugs get in.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_run_requests (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES crew_tasks(id) ON DELETE CASCADE,

  -- Who asked for this run. Same free-form convention as crew_tasks.created_by
  -- ('ceo', 'mail:mbx_...', 'messenger:telegram:...'), because the answer to
  -- "why did this run" is the first thing anyone asks.
  requested_by     TEXT NOT NULL DEFAULT '',

  --   queued     waiting to be claimed (subject to not_before)
  --   running    claimed, lease held
  --   done       the run finished and the task moved on
  --   failed     this attempt failed; back to queued unless attempts ran out
  --   dead       attempts exhausted — a human has to look
  --   cancelled  withdrawn before it ran
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','dead','cancelled')),

  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Defaults to 1 rather than something optimistic: retrying is a decision,
  -- and the vessel's max_retries is what raises it (migration 0011).
  max_attempts     INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),

  -- Earliest epoch-ms this may be claimed. Backoff writes here; 0 means now.
  not_before       INTEGER NOT NULL DEFAULT 0,

  -- The lease. Owner is the drain's id, not the run's: the run does not exist
  -- yet at claim time, which is the whole point of claiming first.
  lease_owner      TEXT,
  lease_expires_at INTEGER,

  -- The run the most recent attempt produced, once there is one.
  run_id           TEXT REFERENCES crew_runs(id) ON DELETE SET NULL,

  last_error       TEXT NOT NULL DEFAULT '',
  correlation_id   TEXT NOT NULL DEFAULT '',

  created_at       INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  finished_at      INTEGER
);

-- The guarantee: at most one unfinished request per task. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_run_requests_live
  ON crew_run_requests(task_id)
  WHERE status IN ('queued','running');

-- The drain's own query: oldest eligible first, within one company.
CREATE INDEX IF NOT EXISTS idx_crew_run_requests_claimable
  ON crew_run_requests(company_id, status, not_before, created_at);
`;

export const migration: Migration = {
  version: 16,
  description: "run requests: a durable queue between intent to run and the run itself",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 16 }, "run request queue table ensured");
  },
};
