// server/modules/bootstrap/migrations/0017-crew-users.ts
//
// IronCrew — who is acting, as opposed to whether they may.
//
// Until now the answer to "who did this" was a constant. One password lived
// in `settings`, a session was a settings row keyed by its own token with no
// identity attached, and every audit event a human caused recorded the actor
// as the literal string "ceo". That is fine for exactly one person and
// becomes a lie the moment a second one gets the password — which for an MSP
// with technicians is not a hypothetical.
//
// An audit log is the one artefact whose whole value is that it is true. A
// hash chain that proves nobody edited the record, over records that all
// claim the same fictional actor, proves the wrong thing carefully.
//
// TWO TABLES, AND WHY SESSIONS MOVE OUT OF `settings`
//
// A session in a key-value table cannot be listed per user, cannot be revoked
// per user, and cannot be indexed by expiry. All three are things an operator
// needs on the day something goes wrong ("log everyone out", "which sessions
// does this account have"). So sessions become a table with a foreign key.
//
// ROLES ARE COARSE ON PURPOSE
//
//   owner     may decide approvals and manage users. The buck stops here.
//   operator  may run the company: create tasks, drive the board, poll,
//             pair agents — everything except approving and user management.
//   viewer    may read. Nothing else.
//
// Three roles that map to real jobs beat a permission matrix nobody
// maintains. The one line worth being precise about: **approving is the
// owner's alone**, because an approval is the gate that stands between an
// agent and an irreversible act, and a gate every operator can open is a gate
// standing open.
//
// NOBODY GETS LOCKED OUT BY THIS MIGRATION
//
// It creates no users. An installation with zero rows keeps working exactly
// as before — the existing single password logs in and is treated as the
// owner (see server/ironcrew/auth/). Users are opt-in, and the moment the
// first one is created the legacy path stops being an implicit owner.
// Upgrading a running server must never be the thing that locks its admin
// out of it.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_users (
  id            TEXT PRIMARY KEY,
  -- Login handle. Lowercased by the store, unique regardless of case: two
  -- accounts differing only in capitalisation are an impersonation waiting
  -- to happen.
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',

  -- scrypt, same helper the single-password path already uses. Never a
  -- plaintext column, and never nullable-as-"no password means anyone".
  password_hash TEXT NOT NULL,

  role          TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('owner','operator','viewer')),

  -- A disabled account keeps its history; deleting it would orphan every
  -- audit entry that names it.
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),

  last_login_at INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_users_email ON crew_users(email);

CREATE TABLE IF NOT EXISTS crew_sessions (
  id            TEXT PRIMARY KEY,
  -- The cookie carries the token; this column stores only its SHA-256. A
  -- stolen database backup then yields no usable session, which is the same
  -- reason the password column holds a hash.
  token_hash    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES crew_users(id) ON DELETE CASCADE,

  -- Soft-bound, as the existing session code already argues: recorded for
  -- incident response, never used to hard-fail a roaming client.
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',

  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  last_seen_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_sessions_token ON crew_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_crew_sessions_user ON crew_sessions(user_id, expires_at);
`;

export const migration: Migration = {
  version: 17,
  description: "users, roles and sessions: an audit log that names a real person",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 17 }, "user and session tables ensured");
  },
};
