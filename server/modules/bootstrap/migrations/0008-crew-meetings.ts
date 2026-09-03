// server/modules/bootstrap/migrations/0008-crew-meetings.ts
//
// IronCrew Phase 2 — meetings.
//
// Deliberately NOT the upstream meetings god-object's O(participants x
// rounds) pattern (see docs/UPSTREAM_ANALYSIS.md): here one round is one
// turn — a single participant speaks per round, selected by the moderator
// or round-robin — so total LLM calls are bounded by max_rounds alone, not
// multiplied by participant count. Each turn's prompt only ever sees a
// bounded recent-turns window (orchestrator.ts), never the whole growing
// transcript, so per-call token cost cannot grow unbounded either.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_meetings (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES crew_projects(id) ON DELETE SET NULL,
  topic               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  moderator_agent_id  TEXT NOT NULL REFERENCES crew_agents(id) ON DELETE CASCADE,
  max_rounds          INTEGER NOT NULL DEFAULT 6,
  budget_micros       INTEGER NOT NULL DEFAULT 0,
  spent_micros        INTEGER NOT NULL DEFAULT 0,
  current_round       INTEGER NOT NULL DEFAULT 0,
  minutes             TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  started_at          INTEGER,
  ended_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crew_meetings_company ON crew_meetings(company_id, status);

CREATE TABLE IF NOT EXISTS crew_meeting_participants (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES crew_meetings(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES crew_agents(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (meeting_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_meeting_participants_meeting ON crew_meeting_participants(meeting_id);

CREATE TABLE IF NOT EXISTS crew_meeting_turns (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES crew_meetings(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES crew_agents(id) ON DELETE CASCADE,
  contribution  TEXT NOT NULL DEFAULT '',
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_meeting_turns_meeting ON crew_meeting_turns(meeting_id, round);

CREATE TABLE IF NOT EXISTS crew_meeting_action_items (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL REFERENCES crew_meetings(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES crew_agents(id) ON DELETE SET NULL,
  task_id           TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_meeting_action_items_meeting ON crew_meeting_action_items(meeting_id);
`;

export const migration: Migration = {
  version: 8,
  description: "crew meetings (bounded rounds, moderator, budget) + action items",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 8 }, "crew meetings tables ensured");
  },
};
