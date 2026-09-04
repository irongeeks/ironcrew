// server/modules/bootstrap/migrations/0019-crew-tool-project-scope.ts
//
// IronCrew — the third way a tool can be scoped.
//
// Migration 0018 gave tools a gate: a grant names an agent or a talent, and
// nothing else may use the tool. The remaining Phase-3 requirement is
// per-project scoping for MCP servers — "the customer's Jira server exists for
// the customer's project and nowhere else", which for an MSP is the whole
// point of having separate projects.
//
// WHY THIS EXTENDS THE EXISTING GATE INSTEAD OF ADDING A SECOND ONE
//
// An MCP server is a tool source. A parallel table of MCP-specific scopes
// would mean two places that answer "may this agent use that", two audit
// trails, and eventually two different answers — which is how a gate becomes
// advisory. So an MCP server is registered in `crew_tools` with origin 'mcp',
// and this migration adds the one dimension the grant table was missing.
//
// A project grant means: any agent working a task in this project may use
// this tool. It is *contextual* rather than personal, which is exactly the
// distinction an MSP needs — the same technician has the customer's tools
// inside the customer's project and not outside it.
//
// PRECEDENCE, WRITTEN DOWN ONCE
//
//   agent   > project > talent
//
// Most specific first: a grant naming this agent is a statement about this
// post; a project grant is a statement about this context; a talent grant is
// a standing statement about the role in general. An operator who wrote the
// narrower one meant it.
//
// THE TABLE IS REBUILT RATHER THAN ALTERED
//
// The CHECK constraint from 0018 requires exactly one of (agent_id,
// talent_id). Adding a column cannot relax it, so a project-only grant would
// violate a constraint that predates the column — SQLite keeps the old CHECK
// text. Rebuilding is the documented way round it, and the copy runs inside
// the migration runner's transaction, so a failure leaves the old shape
// intact.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE crew_tool_grants_new (
  id                TEXT PRIMARY KEY,
  tool_id           TEXT NOT NULL REFERENCES crew_tools(id) ON DELETE CASCADE,

  -- Exactly one of the three is set; see the header for what each means.
  agent_id          TEXT REFERENCES crew_agents(id) ON DELETE CASCADE,
  talent_id         TEXT REFERENCES crew_talents(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES crew_projects(id) ON DELETE CASCADE,

  requires_approval INTEGER CHECK (requires_approval IN (0,1)),
  granted_by        TEXT NOT NULL DEFAULT 'ceo',
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  CHECK (
    (agent_id IS NOT NULL) + (talent_id IS NOT NULL) + (project_id IS NOT NULL) = 1
  )
);

INSERT INTO crew_tool_grants_new
  (id, tool_id, agent_id, talent_id, project_id, requires_approval, granted_by, created_at)
SELECT id, tool_id, agent_id, talent_id, NULL, requires_approval, granted_by, created_at
  FROM crew_tool_grants;

DROP TABLE crew_tool_grants;
ALTER TABLE crew_tool_grants_new RENAME TO crew_tool_grants;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tool_grants_agent
  ON crew_tool_grants(tool_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tool_grants_talent
  ON crew_tool_grants(tool_id, talent_id) WHERE talent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tool_grants_project
  ON crew_tool_grants(tool_id, project_id) WHERE project_id IS NOT NULL;
`;

export const migration: Migration = {
  version: 19,
  description: "tool grants gain a project scope, so an MCP server can belong to one customer's project",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 19 }, "tool grants rebuilt with project scope");
  },
};
