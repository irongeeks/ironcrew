/**
 * IronCrew — the record of what arrived from outside, and what was done with it.
 *
 * Mailboxes already deduplicated their own mail. This is the same rule for
 * every ingress: an event is identified by its source and the id that source
 * considers stable, and seeing it again is a lookup rather than a second task.
 *
 * Three states, and the distinction between the last two is the point:
 *
 *   unseen      never arrived
 *   seen        recorded, nothing has acted on it yet
 *   handled     something acted on it, and said what and when
 *
 * A process that dies between recording and acting leaves an event `seen` but
 * not `handled` — which is exactly what `unhandled()` finds, and why the two
 * are not one boolean.
 *
 * Payloads here are third-party content. They are sanitised at the ingress
 * (policy/untrusted-content.ts), never on the way out, because a value that
 * was safe to store must not depend on every reader remembering to clean it.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";

export interface ExternalEventRow {
  id: string;
  company_id: string;
  source_kind: string;
  source_id: string;
  external_id: string;
  event_type: string;
  payload_json: string;
  occurred_at: number | null;
  received_at: number;
  handled_at: number | null;
  handler: string;
  task_id: string | null;
  delivery_count: number;
}

const COLUMNS = `id, company_id, source_kind, source_id, external_id, event_type, payload_json,
  occurred_at, received_at, handled_at, handler, task_id, delivery_count`;

export interface RecordEventInput {
  companyId: string;
  sourceKind: string;
  /** Which instance of that source — a mailbox id, a channel id. */
  sourceId?: string;
  externalId: string;
  eventType?: string;
  /** Already sanitised by the ingress. See this module's doc-comment. */
  payload?: unknown;
  occurredAt?: number | null;
}

export interface RecordEventResult {
  event: ExternalEventRow;
  /**
   * False when this event had already been recorded. A caller that acts on
   * `isNew` alone gets at-most-once behaviour for free.
   */
  isNew: boolean;
}

export class ExternalEventStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Records an arrival, or recognises a repeat.
   *
   * A repeat does not overwrite the stored payload. The first delivery is the
   * one that was acted on, and replacing it later would make the record
   * disagree with what actually happened — but `delivery_count` rises, so a
   * source redelivering endlessly is visible rather than silent.
   */
  record(input: RecordEventInput): RecordEventResult {
    const sourceId = input.sourceId ?? "";
    const existing = this.find(input.companyId, input.sourceKind, sourceId, input.externalId);

    if (existing) {
      this.db
        .prepare("UPDATE crew_external_events SET delivery_count = delivery_count + 1 WHERE id = ?")
        .run(existing.id);
      return { event: this.get(existing.id)!, isNew: false };
    }

    const id = newId("xevt");
    this.db
      .prepare(
        `INSERT INTO crew_external_events
           (id, company_id, source_kind, source_id, external_id, event_type, payload_json, occurred_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.sourceKind,
        sourceId,
        input.externalId,
        input.eventType ?? "",
        JSON.stringify(input.payload ?? {}),
        input.occurredAt ?? null,
      );

    return { event: this.get(id)!, isNew: true };
  }

  get(id: string): ExternalEventRow | null {
    return oneRow<ExternalEventRow>(this.db.prepare(`SELECT ${COLUMNS} FROM crew_external_events WHERE id = ?`), id);
  }

  find(companyId: string, sourceKind: string, sourceId: string, externalId: string): ExternalEventRow | null {
    return oneRow<ExternalEventRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_external_events
          WHERE company_id = ? AND source_kind = ? AND source_id = ? AND external_id = ?`,
      ),
      companyId,
      sourceKind,
      sourceId,
      externalId,
    );
  }

  /**
   * Marks an event as acted upon, naming what acted and what it produced.
   *
   * Idempotent by design: marking twice keeps the first handler and time. A
   * retry that succeeds on the second attempt should not rewrite history to
   * claim it was always fine.
   */
  markHandled(
    id: string,
    handler: string,
    opts: { taskId?: string | null; now?: number } = {},
  ): ExternalEventRow | null {
    const event = this.get(id);
    if (!event) return null;
    if (event.handled_at !== null) return event;

    this.db
      .prepare("UPDATE crew_external_events SET handled_at = ?, handler = ?, task_id = ? WHERE id = ?")
      .run(opts.now ?? Date.now(), handler, opts.taskId ?? null, id);
    return this.get(id);
  }

  /**
   * Events that arrived but were never acted on — the ones a crash between
   * recording and handling leaves behind.
   */
  unhandled(companyId: string, limit = 100): ExternalEventRow[] {
    return allRows<ExternalEventRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_external_events
          WHERE company_id = ? AND handled_at IS NULL
          ORDER BY received_at ASC LIMIT ?`,
      ),
      companyId,
      limit,
    );
  }

  /** Recent arrivals, newest first — optionally narrowed to one source. */
  list(companyId: string, opts: { sourceKind?: string; sourceId?: string; limit?: number } = {}): ExternalEventRow[] {
    const limit = opts.limit ?? 50;
    if (opts.sourceKind !== undefined && opts.sourceId !== undefined) {
      return allRows<ExternalEventRow>(
        this.db.prepare(
          `SELECT ${COLUMNS} FROM crew_external_events
            WHERE company_id = ? AND source_kind = ? AND source_id = ?
            ORDER BY received_at DESC LIMIT ?`,
        ),
        companyId,
        opts.sourceKind,
        opts.sourceId,
        limit,
      );
    }
    if (opts.sourceKind !== undefined) {
      return allRows<ExternalEventRow>(
        this.db.prepare(
          `SELECT ${COLUMNS} FROM crew_external_events
            WHERE company_id = ? AND source_kind = ?
            ORDER BY received_at DESC LIMIT ?`,
        ),
        companyId,
        opts.sourceKind,
        limit,
      );
    }
    return allRows<ExternalEventRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_external_events
          WHERE company_id = ? ORDER BY received_at DESC LIMIT ?`,
      ),
      companyId,
      limit,
    );
  }

  /**
   * Reopens a handled event so it can be processed again.
   *
   * The deliberate part: this clears `handled_at`, `handler` and `task_id`
   * but leaves the payload untouched. Replay means "run the current handler
   * against what actually arrived" — if replay could alter the payload, it
   * would be re-writing the input to get the output someone wanted, which is
   * the opposite of what a replay is for.
   *
   * The task the first attempt produced is deliberately NOT deleted: it may
   * carry work, comments or decisions. Unlinking makes the replay's own
   * result attributable while leaving the earlier one to be dealt with
   * deliberately.
   */
  replay(id: string): ExternalEventRow | null {
    const event = this.get(id);
    if (!event) return null;

    this.db
      .prepare("UPDATE crew_external_events SET handled_at = NULL, handler = '', task_id = NULL WHERE id = ?")
      .run(id);
    return this.get(id);
  }

  /** Parses the stored payload. Returns `{}` for anything unreadable. */
  payloadOf(event: ExternalEventRow): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(event.payload_json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Drops events older than `olderThanMs`, returning how many went.
   *
   * Handled events only: an unhandled event is outstanding work, and pruning
   * it would lose the arrival without anyone ever having acted on it.
   */
  prune(companyId: string, olderThanMs: number, now = Date.now()): number {
    const result = this.db
      .prepare(
        `DELETE FROM crew_external_events
          WHERE company_id = ? AND handled_at IS NOT NULL AND received_at < ?`,
      )
      .run(companyId, now - olderThanMs);
    return Number(result.changes);
  }
}
