// server/modules/bootstrap/migrations/0007-crew-remote-workers.ts
//
// IronCrew — remote workers, reached over a tailnet (Tailscale or a
// self-hosted, protocol-compatible control server such as Headscale).
//
// A row is metadata only: an SSH connection target (host, port, user,
// private_key_path) plus a label and an environment tag ("tier0",
// "customer:acme", ...). `private_key_path` is a filesystem path the server
// process reads at connect time — never key material stored in the row,
// the same convention server/modules/workflow/ssh/types.ts's SshConfig
// already uses. `host` is expected to be a tailnet hostname or IP, so SSH
// traffic to it never leaves the tailnet, but nothing here enforces that —
// it is exactly as reachable as any other SSH target the operator points
// it at.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_remote_workers (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  environment        TEXT NOT NULL DEFAULT '',
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT NOT NULL,
  private_key_path   TEXT NOT NULL,
  known_hosts_policy TEXT NOT NULL DEFAULT 'strict'
                     CHECK (known_hosts_policy IN ('strict','accept')),
  notes              TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, label)
);
CREATE INDEX IF NOT EXISTS idx_crew_remote_workers_company ON crew_remote_workers(company_id);
`;

export const migration: Migration = {
  version: 7,
  description: "crew remote workers (SSH-over-tailnet connection targets)",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 7 }, "crew remote workers table ensured");
  },
};
