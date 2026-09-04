// server/modules/bootstrap/migrations/0014-crew-change-proposals.ts
//
// IronCrew — an agent proposes file changes; the owner approves; then they apply.
//
// Today an agent with a workspace either writes to it or it does not. There is
// no state in between — nothing an owner can look at, weigh and accept. That
// makes every file-touching capability an all-or-nothing trust decision, which
// is why such capabilities stay switched off.
//
// A change proposal is that missing middle: the agent produces the exact
// content it wants written, the proposal raises an `ApprovalRequest` of type
// `file_change`, and **nothing reaches the disk until that approval is
// approved**. The owner sees paths and contents before deciding, not after.
//
// THE CONSTRAINT THAT MATTERS MOST
//
// `expected_sha256` records what each file looked like *when the proposal was
// made*. On apply, a file whose hash no longer matches is refused.
//
// Without that, an approval granted an hour ago silently clobbers every edit
// made since — by a person, by another agent, by a git pull. The owner
// approved a change against a state of the world; if the world moved, the
// approval no longer describes what would happen, so it stops being an
// approval. Refusing is the only honest outcome.
//
// A creation records an empty expected hash and refuses if the file now
// exists: "create" that quietly overwrites is a different act than the one
// approved.
//
// PATHS
//
// `workspace_path` is the root every file must stay inside, checked at apply
// time by resolving the path and re-testing containment (see
// change-proposal-store.ts). `..`, absolute paths and symlink escapes are all
// the same failure: outside the root.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_change_proposals (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  run_id         TEXT,
  agent_id       TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,

  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',

  -- The root every file in this proposal must resolve inside.
  workspace_path TEXT NOT NULL,

  -- The approval that gates it. A proposal without one can never be applied,
  -- which is the whole mechanism.
  approval_id    TEXT REFERENCES crew_approvals(id) ON DELETE SET NULL,

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','applied','failed','superseded')),

  applied_at     INTEGER,
  applied_by     TEXT NOT NULL DEFAULT '',
  apply_error    TEXT NOT NULL DEFAULT '',

  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_change_proposals_company
  ON crew_change_proposals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_change_proposals_task
  ON crew_change_proposals(task_id);

CREATE TABLE IF NOT EXISTS crew_change_proposal_files (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT NOT NULL REFERENCES crew_change_proposals(id) ON DELETE CASCADE,

  -- Relative to the proposal's workspace_path. Never absolute.
  path            TEXT NOT NULL,
  operation       TEXT NOT NULL
                  CHECK (operation IN ('create','update','delete')),

  -- What should be written. Empty for a delete.
  content         TEXT NOT NULL DEFAULT '',

  -- What the file looked like when this was proposed; '' for a create.
  -- Apply refuses when the file's current hash differs — see the header.
  expected_sha256 TEXT NOT NULL DEFAULT '',
  -- What was actually written, recorded on a successful apply.
  applied_sha256  TEXT NOT NULL DEFAULT '',

  UNIQUE (proposal_id, path)
);
CREATE INDEX IF NOT EXISTS idx_crew_change_proposal_files_proposal
  ON crew_change_proposal_files(proposal_id);
`;

export const migration: Migration = {
  version: 14,
  description: "change proposals: an agent proposes file edits, the owner approves, then they apply",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 14 }, "change proposal tables ensured");
  },
};
