// server/modules/bootstrap/migrations/0022-crew-packs.ts
//
// IronCrew — business packs.
//
// Phase 4's line is short and it is the whole specification: "Every
// integration ships behind a feature flag as a real adapter. No fake buttons."
//
// A pack is the answer to a question the product could not answer before:
// *this* company does MSP work, *that* one runs a web agency, and the
// thirteen agents seeded at first boot are the same for both. A pack adds the
// departments, the agents, the tools and the routines a particular trade
// needs — and, where that trade has real systems, the adapters that talk to
// them.
//
// WHY WE RECORD WHAT A PACK CREATED, RATHER THAN RE-DERIVING IT
//
// Uninstall is the reason. A pack definition is code and code changes: the
// version installed six months ago may have created a department this
// version no longer mentions. Re-deriving "what to remove" from the current
// definition would then orphan exactly the objects nobody remembers.
// `crew_pack_objects` is the receipt — every row this installation created,
// with the pack that created it — so removal is precise, and so is the
// refusal when one of those objects has since been used.
//
// WHY A PACK CANNOT SILENTLY REPLACE WHAT IT DID NOT CREATE
//
// The unique index on (company_id, object_type, object_id) means one object
// belongs to at most one pack. Two packs both wanting a "Finance" department
// do not fight over it: the second finds the key taken and reuses the
// existing object without claiming it. An operator's own department is never
// swallowed by a pack install, and never removed by a pack uninstall.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No pack marketplace, no remote source, no version negotiation. Packs are
// code in this repository, installed by key. `crew_marketplaces` already
// covers "fetch something from elsewhere and run it", and that surface has
// its own threat model (T-12); a second one would double the attack surface
// for a feature nobody has asked for.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_packs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  -- The pack's stable key ("msp", "finance", ...). Code, not user input.
  pack_key      TEXT NOT NULL,
  -- The definition's version at install time. Kept so an operator can see
  -- that what runs is older than what ships, which is the only honest way to
  -- offer an upgrade later.
  version       TEXT NOT NULL,

  installed_at  INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  -- The person, once there is one (docs/IDENTITY.md). "ceo" while nobody has
  -- a name yet.
  installed_by  TEXT NOT NULL DEFAULT 'ceo',

  UNIQUE (company_id, pack_key)
);

CREATE TABLE IF NOT EXISTS crew_pack_objects (
  id            TEXT PRIMARY KEY,
  pack_id       TEXT NOT NULL REFERENCES crew_packs(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  object_type   TEXT NOT NULL CHECK (object_type IN ('department','agent','tool','routine')),
  object_id     TEXT NOT NULL,
  -- The definition key this object came from, so a later version can find
  -- "the agent that used to be called X" without guessing from display names.
  object_key    TEXT NOT NULL,

  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

-- One object belongs to at most one pack. See the header: this is what stops
-- a pack from claiming, or removing, something it did not create.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_pack_objects_unique
  ON crew_pack_objects (company_id, object_type, object_id);

CREATE INDEX IF NOT EXISTS idx_crew_pack_objects_pack
  ON crew_pack_objects (pack_id, object_type);
`;

export const migration: Migration = {
  version: 22,
  description: "business packs: what a trade adds to the company, and the receipt for removing it",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ module: "migrations", version: 22 }, "business pack tables ensured");
  },
};

export default migration;
