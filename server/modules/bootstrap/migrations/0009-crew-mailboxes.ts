// server/modules/bootstrap/migrations/0009-crew-mailboxes.ts
//
// IronCrew — mailboxes, and which agents may work them.
//
// Three tables, one idea each:
//
//   crew_mailboxes         one connected mailbox (IMAP, JMAP, Microsoft 365
//                          Exchange Online, or Gmail), including the two
//                          per-mailbox behaviour switches the owner sets:
//                          whether IronCrew polls it at all, and whether new
//                          mail is auto-triaged into tasks.
//   crew_mailbox_agents    the n:n grant table — an agent may hold several
//                          mailboxes, a mailbox may be worked by several
//                          agents. No row means no access: deny by default,
//                          the same posture vendor policy and per-agent tool
//                          access already take.
//   crew_mailbox_messages  an index of messages IronCrew has already seen,
//                          for de-duplication and triage provenance.
//
// Two deliberate decisions worth stating plainly:
//
// 1. `credentials_encrypted` holds an AES-256-GCM blob (see
//    server/ironcrew/mail/credential-cipher.ts), NOT a `SecretRef` into a
//    password manager the way crew_secrets does. That is a conscious
//    departure from "only SecretRef values are stored in the database"
//    (docs/THREAT_MODEL.md), chosen so a mailbox can be connected without
//    requiring Vaultwarden/Proton Pass, and so OAuth refresh tokens can be
//    rotated automatically. The trade-off: anyone who obtains both the
//    database file and the encryption key can read mailbox credentials.
//    Encryption keys never live in this table.
//
// 2. crew_mailbox_messages stores metadata only — subject, sender, dates,
//    ids. Message bodies are never copied into IronCrew's database; they
//    are read from the mailbox on demand. IronCrew indexes your mail, it
//    does not become a second copy of it.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_mailboxes (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL,
  kind                  TEXT NOT NULL
                        CHECK (kind IN ('imap','jmap','m365','gmail')),
  email_address         TEXT NOT NULL,

  -- Connection targets. Which of these matter depends on \`kind\`; the rest
  -- stay empty rather than being spread across per-kind tables.
  host                  TEXT NOT NULL DEFAULT '',
  port                  INTEGER NOT NULL DEFAULT 0,
  use_tls               INTEGER NOT NULL DEFAULT 1,
  username              TEXT NOT NULL DEFAULT '',
  smtp_host             TEXT NOT NULL DEFAULT '',
  smtp_port             INTEGER NOT NULL DEFAULT 0,
  session_url           TEXT NOT NULL DEFAULT '',
  tenant_id             TEXT NOT NULL DEFAULT '',
  client_id             TEXT NOT NULL DEFAULT '',

  -- AES-256-GCM blob; never a plaintext password or token. See the header.
  credentials_encrypted TEXT NOT NULL DEFAULT '',

  -- Per-mailbox behaviour. auto_triage without poll_enabled would be a
  -- setting that silently does nothing, so the schema refuses it outright.
  poll_enabled          INTEGER NOT NULL DEFAULT 0,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
  auto_triage           INTEGER NOT NULL DEFAULT 0,

  -- Live status, reported from real polls rather than assumed.
  last_polled_at        INTEGER,
  last_error            TEXT NOT NULL DEFAULT '',

  created_at            INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, label),
  CHECK (auto_triage = 0 OR poll_enabled = 1)
);
CREATE INDEX IF NOT EXISTS idx_crew_mailboxes_company ON crew_mailboxes(company_id, kind);
CREATE INDEX IF NOT EXISTS idx_crew_mailboxes_poll ON crew_mailboxes(poll_enabled, last_polled_at);

CREATE TABLE IF NOT EXISTS crew_mailbox_agents (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES crew_mailboxes(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES crew_agents(id) ON DELETE CASCADE,
  access      TEXT NOT NULL DEFAULT 'read'
              CHECK (access IN ('read','send')),
  granted_at  INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (mailbox_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_mailbox_agents_agent ON crew_mailbox_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_crew_mailbox_agents_mailbox ON crew_mailbox_agents(mailbox_id);

CREATE TABLE IF NOT EXISTS crew_mailbox_messages (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES crew_mailboxes(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  message_id   TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  received_at  INTEGER,
  task_id      TEXT,
  triaged_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (mailbox_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_mailbox_messages_mailbox ON crew_mailbox_messages(mailbox_id, received_at);
`;

export const migration: Migration = {
  version: 9,
  description: "crew mailboxes (IMAP/JMAP/M365/Gmail), n:n agent grants, seen-message index",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 9 }, "crew mailbox tables ensured");
  },
};
