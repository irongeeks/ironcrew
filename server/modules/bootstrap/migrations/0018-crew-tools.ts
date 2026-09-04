// server/modules/bootstrap/migrations/0018-crew-tools.ts
//
// IronCrew — what an agent may reach for, and what that costs in trust.
//
// The company can already say which *model* an agent runs on, how long it may
// run and whether an act needs approval. What it cannot say is the thing an
// operator actually worries about: this agent may search the web, that one
// may not touch a browser at all, and nobody publishes anything without being
// asked first.
//
// Today a tool is either compiled in or installed from a marketplace, and
// once present it is available to everyone. That is the same shape the
// mailbox grants and the messenger pairings already rejected — presence is
// not permission — so tools get the same treatment: a registry of what
// exists, and explicit grants for who may use it.
//
// RISK IS A PROPERTY OF THE TOOL, NOT OF THE GRANT
//
// `risk_class` sits on the tool because it describes what the tool can do to
// the world, which does not change per agent:
//
//   read        observes and returns text. A web search, a file read.
//   write       changes something inside the company's own workspace.
//   external    reaches out and *acts* on something outside — submits a form,
//               sends a request that another system will treat as real.
//
// A grant then says whether this agent may use it, and whether each use
// needs an approval first. An `external` tool defaults to requiring one, and
// the store refuses to create a grant that waives it for `external` without
// the owner saying so explicitly — which is the difference between a browser
// that reads a page and a browser that clicks "Kaufen".
//
// WHY `requires_approval` IS ON THE GRANT AND NOT ONLY THE TOOL
//
// Because the same tool is a different risk in different hands. A browser
// used by the research agent to read documentation and the same browser used
// by the sales agent to submit a form are not the same act, and one blanket
// setting would have to be pessimistic enough for the worst case, which in
// practice means everyone turns it off.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_tools (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  -- Stable identifier a runtime asks for: 'web.search', 'browser.navigate'.
  key            TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',

  -- See the header: what this tool can do to the world.
  risk_class     TEXT NOT NULL DEFAULT 'read'
                 CHECK (risk_class IN ('read','write','external')),

  -- Where it comes from, for provenance: 'builtin', 'mcp', 'marketplace'.
  origin         TEXT NOT NULL DEFAULT 'builtin',

  -- A tool present but switched off company-wide. Cheaper and more honest
  -- than deleting it, which would orphan the grants that reference it.
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),

  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_crew_tools_company ON crew_tools(company_id, risk_class, enabled);

CREATE TABLE IF NOT EXISTS crew_tool_grants (
  id                TEXT PRIMARY KEY,
  tool_id           TEXT NOT NULL REFERENCES crew_tools(id) ON DELETE CASCADE,

  -- Exactly one of these is set. A grant to a talent follows the role
  -- wherever it is paired (so "every CTO may search the web" survives an
  -- agent being rebuilt); a grant to an agent is for this one post.
  agent_id          TEXT REFERENCES crew_agents(id) ON DELETE CASCADE,
  talent_id         TEXT REFERENCES crew_talents(id) ON DELETE CASCADE,

  -- Per-grant, for the reason in the header. NULL means "inherit the tool's
  -- default", which is what keeps an external tool safe by omission.
  requires_approval INTEGER CHECK (requires_approval IN (0,1)),

  granted_by        TEXT NOT NULL DEFAULT 'ceo',
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  -- Enforced here rather than trusted: a grant naming both an agent and a
  -- talent, or neither, has no defensible meaning.
  CHECK ((agent_id IS NOT NULL AND talent_id IS NULL) OR (agent_id IS NULL AND talent_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tool_grants_agent
  ON crew_tool_grants(tool_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tool_grants_talent
  ON crew_tool_grants(tool_id, talent_id) WHERE talent_id IS NOT NULL;
`;

export const migration: Migration = {
  version: 18,
  description: "tool registry and grants: presence is not permission, for tools too",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 18 }, "tool registry tables ensured");
  },
};
