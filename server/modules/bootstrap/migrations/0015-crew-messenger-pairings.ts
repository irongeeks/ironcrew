// server/modules/bootstrap/migrations/0015-crew-messenger-pairings.ts
//
// IronCrew — who is allowed to talk to the executive assistant.
//
// Inbound messaging is a new ingress, and an ingress without an identity
// check is an open door. A Telegram bot token or a Discord channel id is not
// a secret in any meaningful sense: anyone who finds the bot can message it.
// So the question this table answers is not "did a message arrive" but
// "may *this sender* speak to the EA".
//
// THE ANSWER IS NO UNTIL THE OWNER SAYS OTHERWISE
//
// An unknown sender produces a `pending` row with a short-lived code and
// nothing else — no task, no EA turn, no reply beyond "ask the owner to
// confirm this code". The owner confirms it in the Command Center, where they
// can see who is asking. Only then does the row become `active`.
//
// This is the same deny-by-default posture the mailbox grants take: no row,
// no access.
//
// WHY `role` MATTERS MORE THAN `status`
//
// A paired sender with role `owner` reaches `handleCeoMessage()` — which is
// the whole point, since that is Robert talking to his own EA. That path
// treats its text as the owner speaking and can delegate work immediately.
//
// So `owner` is not a label, it is the authority to act as the CEO through a
// chat app. Anything else routes like incoming mail does: an `inbox` task,
// quoted as third-party content, never an instruction
// (docs/THREAT_MODEL.md T-10). The two roles exist precisely so that
// distinction is a column someone can look at, rather than a branch someone
// has to remember.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_messenger_pairings (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  channel_kind    TEXT NOT NULL,
  -- Where to reply. Separate from sender_id because a channel and a person
  -- are not the same thing: several people can write in one Discord channel.
  chat_id         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  display_name    TEXT NOT NULL DEFAULT '',

  -- 'owner' may speak as the CEO; 'guest' is routed like incoming mail.
  -- See the header: this column is authority, not a label.
  role            TEXT NOT NULL DEFAULT 'guest'
                  CHECK (role IN ('owner','guest')),

  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','blocked')),

  -- Short-lived, single-use, and cleared the moment it is accepted.
  pairing_code    TEXT NOT NULL DEFAULT '',
  code_expires_at INTEGER,

  paired_at       INTEGER,
  last_seen_at    INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  -- One row per person per channel kind. A second Telegram account is a
  -- second row, and has to be paired on its own.
  UNIQUE (company_id, channel_kind, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_crew_messenger_pairings_company
  ON crew_messenger_pairings(company_id, channel_kind, status);
`;

export const migration: Migration = {
  version: 15,
  description: "messenger pairings: deny-by-default identity for inbound chat, and who may speak as the CEO",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 15 }, "messenger pairing table ensured");
  },
};
