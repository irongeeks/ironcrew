// server/modules/bootstrap/migrations/0005-crew-attachments.ts
//
// IronCrew — file attachments.
//
// One table covers three scopes, distinguished by which FK is set:
//  - task_id set, project_id null  -> attached to that task
//  - project_id set, task_id null  -> attached to that project
//  - both null                     -> the general, company-wide document store
// (never both set — enforced at the store layer, not by a CHECK, matching
// this codebase's existing convention of app-layer cross-entity validation).
//
// The row is metadata only; the byte content lives on disk under a
// generated, non-user-controlled storage_key (see
// server/ironcrew/domain/attachment-storage.ts) — never the raw
// filename, so a crafted filename can never become a path-traversal
// primitive.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_attachments (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES crew_tasks(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES crew_projects(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL,
  storage_key   TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL DEFAULT 'ceo',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS idx_crew_attachments_company ON crew_attachments(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crew_attachments_task ON crew_attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_crew_attachments_project ON crew_attachments(project_id);
`;

export const migration: Migration = {
  version: 5,
  description: "ironcrew file attachments (task/project-scoped + general document store)",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 5 }, "ironcrew attachments table ensured");
  },
};
