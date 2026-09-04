// server/modules/bootstrap/migrations/0020-crew-secrets-keychain.ts
//
// IronCrew — the OS keychain as a third secret provider.
//
// `crew_secrets` has always been refs only, never plaintext, and the CHECK
// constraint named the two vaults that existed: Vaultwarden and Proton Pass.
// The roadmap's Phase 3 asks for the operating system's own keychain as well,
// and a CHECK constraint written before it cannot be widened in place —
// SQLite keeps the original text — so the table is rebuilt.
//
// WHAT THE KEYCHAIN IS GOOD FOR, AND WHAT IT IS NOT
//
// On a workstation it is the right default: the secret is already protected
// by the login the operator performs anyway, and nothing extra has to run.
//
// On a **headless server** it is the wrong choice, and that is worth stating
// here rather than only in the docs. libsecret needs a running daemon and an
// unlocked collection; a service starting at boot has neither, so a keychain
// ref resolves to a failure at the worst moment — during a run, not during
// configuration. A server should use Vaultwarden or Proton Pass, both of
// which authenticate non-interactively by design.
//
// The rebuild preserves every existing row, and runs inside the migration
// runner's transaction, so a failure leaves the old shape intact.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE crew_secrets_new (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('vaultwarden','protonpass','keychain')),
  item_ref      TEXT NOT NULL,
  field         TEXT,
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, name)
);

INSERT INTO crew_secrets_new
  (id, company_id, name, provider, item_ref, field, description, created_at, updated_at)
SELECT id, company_id, name, provider, item_ref, field, description, created_at, updated_at
  FROM crew_secrets;

DROP TABLE crew_secrets;
ALTER TABLE crew_secrets_new RENAME TO crew_secrets;
CREATE INDEX IF NOT EXISTS idx_crew_secrets_company ON crew_secrets(company_id, name);
`;

export const migration: Migration = {
  version: 20,
  description: "secret refs may name the OS keychain, alongside Vaultwarden and Proton Pass",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 20 }, "secret provider set widened to include the OS keychain");
  },
};
