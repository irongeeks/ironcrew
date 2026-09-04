// server/modules/bootstrap/migrations/0010-crew-marketplaces.ts
//
// IronCrew — marketplaces for skills and MCP servers.
//
// Two tables:
//
//   crew_marketplaces          a source IronCrew can browse for installable
//                              things. Four kinds, because the ecosystem has
//                              four shapes worth supporting:
//                                catalog        a plain JSON catalog at a URL
//                                mcp-registry   registry.modelcontextprotocol.io
//                                claude-plugin  a Claude-Code marketplace
//                                               (.claude-plugin/marketplace.json)
//                                git            a Git repository installed
//                                               directly, no catalog involved
//
//   crew_marketplace_installs  what was actually installed, from where, and
//                              when. This is provenance, not a cache: when a
//                              marketplace is removed the install row stays
//                              (marketplace_id becomes NULL) so a server or
//                              skill on this machine can always be traced back
//                              to the URL it came from.
//
// Deliberate decisions:
//
// 1. The installed artefacts themselves do NOT live here. MCP servers are
//    written into the existing `settings` row "mcp_servers" via McpManager,
//    and skills into <cwd>/custom-skills/<name>/. IronCrew adds provenance to
//    the infrastructure that already exists rather than a second copy of it —
//    so a marketplace-installed server behaves exactly like a hand-added one.
//
// 2. `manifest` keeps the entry as the source served it, at install time.
//    A source can change or disappear; what an admin approved must stay
//    readable afterwards. It is data for audit, never re-executed.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_marketplaces (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('catalog','mcp-registry','claude-plugin','git')),
  url            TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,

  -- Result of the last sync. Kept on the row so the UI can show a source as
  -- broken without re-fetching it on every render.
  last_synced_at INTEGER,
  last_error     TEXT NOT NULL DEFAULT '',
  entry_count    INTEGER NOT NULL DEFAULT 0,

  created_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crew_marketplaces_company ON crew_marketplaces(company_id, kind);

CREATE TABLE IF NOT EXISTS crew_marketplace_installs (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  -- Nullable, and ON DELETE SET NULL: removing a source must not erase the
  -- record of what it put on this machine.
  marketplace_id TEXT REFERENCES crew_marketplaces(id) ON DELETE SET NULL,

  entry_id       TEXT NOT NULL,
  entry_type     TEXT NOT NULL
                 CHECK (entry_type IN ('mcp','skill')),

  -- The name the artefact carries where it actually lives: the MCP server
  -- name in settings, or the custom-skill directory.
  name           TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '',
  source_url     TEXT NOT NULL DEFAULT '',
  installed_by   TEXT NOT NULL DEFAULT '',
  manifest       TEXT NOT NULL DEFAULT '',
  installed_at   INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  -- One install per name and type: installing again updates this row rather
  -- than leaving two records claiming the same MCP server name.
  UNIQUE (company_id, entry_type, name)
);
CREATE INDEX IF NOT EXISTS idx_crew_marketplace_installs_source
  ON crew_marketplace_installs(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_crew_marketplace_installs_company
  ON crew_marketplace_installs(company_id, entry_type);
`;

export const migration: Migration = {
  version: 10,
  description: "crew marketplaces (catalog, MCP registry, Claude-Code plugins, Git) and install provenance",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 10 }, "crew marketplace tables ensured");
  },
};
