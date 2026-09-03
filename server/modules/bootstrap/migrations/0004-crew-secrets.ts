// server/modules/bootstrap/migrations/0004-crew-secrets.ts
//
// IronCrew — password-manager integration (Vaultwarden / Proton Pass).
//
// Per docs/THREAT_MODEL.md: "Only SecretRef values are stored in the
// database — never plaintext." This table deliberately has no value/secret
// column at all — only a pointer to where the secret lives in an external
// vault (provider + item_ref + optional field). Resolving that pointer to
// its live value happens on demand via a SecretProvider
// (server/ironcrew/secrets/) and the value is never persisted here.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_secrets (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('vaultwarden','protonpass')),
  item_ref      TEXT NOT NULL,
  field         TEXT,
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crew_secrets_company ON crew_secrets(company_id, name);
`;

export const migration: Migration = {
  version: 4,
  description: "ironcrew secret refs (vaultwarden / proton pass — refs only, never plaintext)",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 4 }, "ironcrew secrets table ensured");
  },
};
