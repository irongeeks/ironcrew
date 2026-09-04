// server/modules/bootstrap/migrations/0013-crew-external-events.ts
//
// IronCrew — every event from outside, recorded once.
//
// Mailboxes already do this for mail: `crew_mailbox_messages` has
// `UNIQUE (mailbox_id, external_id)`, so polling the same inbox twice does
// not create the same task twice. That rule is not specific to mail — it is
// what every external source needs, and each new one re-inventing it is how
// they end up subtly different.
//
// This is the general form. A source names itself (`source_kind`,
// `source_id`) and the event carries whatever id that source considers
// stable (`external_id`); the three together are unique. Seeing an event a
// second time is then a lookup, not a duplicate task, a duplicate
// notification, or a duplicate anything.
//
// WHY THE PAYLOAD IS STORED, AND WHAT THAT COSTS
//
// Replay is the reason. When triage mis-files an event, or a handler had a
// bug, or a run died half-way, the useful question is "what exactly did we
// receive?" — and re-fetching from the source is often impossible: a webhook
// delivery is gone, a chat message may be edited, a poll window has moved on.
// So the payload is kept as received.
//
// The cost is that this table holds third-party content, which means:
//
//   * It is written through `wrapUntrusted`/`sanitiseLine` at the ingress,
//     never raw — the same rule the mail path follows (THREAT_MODEL T-10).
//     A payload here is data to be shown and re-processed, and it must not
//     be able to carry a forged turn boundary into a prompt on replay.
//   * `payload_json` is capped by the ingress, not by this schema, because
//     what "too big" means differs per source.
//   * Rows are prunable: `received_at` is indexed so an operator can drop
//     everything older than a retention window without a table scan.
//
// `handled_at` and `handler` record that something was actually done with an
// event, which is what separates "seen" from "processed" — a distinction that
// matters when a process dies between the two.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_external_events (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  -- Which kind of source, and which instance of it. A mailbox id, a Discord
  -- channel id, a webhook id — whatever identifies the one source this came
  -- from, so two sources of the same kind cannot collide.
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL DEFAULT '',

  -- The id the source itself considers stable for this event.
  external_id   TEXT NOT NULL,

  -- What it is, in the source's own words (e.g. "message", "issue.opened").
  event_type    TEXT NOT NULL DEFAULT '',

  -- The event as received, already sanitised at the ingress. See the header.
  payload_json  TEXT NOT NULL DEFAULT '{}',

  -- When the source says it happened, vs. when we first saw it. They differ
  -- after an outage, and the difference is worth keeping.
  occurred_at   INTEGER,
  received_at   INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  -- "Seen" and "processed" are different states, and a process can die
  -- between them. NULL handled_at means nothing acted on this yet.
  handled_at    INTEGER,
  handler       TEXT NOT NULL DEFAULT '',
  task_id       TEXT REFERENCES crew_tasks(id) ON DELETE SET NULL,

  -- How many times this event has been delivered to us. A second delivery is
  -- normal (at-least-once sources exist); a hundredth is a symptom.
  delivery_count INTEGER NOT NULL DEFAULT 1,

  UNIQUE (company_id, source_kind, source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crew_external_events_source
  ON crew_external_events(company_id, source_kind, source_id, received_at);
-- Finding what still needs handling, and pruning by age, are the two scans
-- that must not walk the whole table.
CREATE INDEX IF NOT EXISTS idx_crew_external_events_unhandled
  ON crew_external_events(company_id, handled_at);
CREATE INDEX IF NOT EXISTS idx_crew_external_events_received
  ON crew_external_events(company_id, received_at);
`;

export const migration: Migration = {
  version: 13,
  description: "external event log: dedupe by (source, external id) across every ingress, and replay",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 13 }, "external event table ensured");
  },
};
