/**
 * IronCrew — shipping the audit log off the box.
 *
 * THE PROBLEM THIS SOLVES
 *
 * domain/audit.ts hash-chains every entry: each row carries `prev_hash` and
 * `entry_hash`, so editing or deleting a historical row breaks the chain and
 * `verifyAuditChain()` reports exactly where. That makes tampering
 * *detectable* — but only for someone who still holds the chain.
 *
 * It does nothing against an attacker who owns the box. Nothing about the
 * chain is anchored anywhere: an attacker with write access to the SQLite
 * file can truncate `crew_audit_events` at any seq and recompute every hash
 * forward from that point with the same public algorithm. The result passes
 * `verifyAuditChain()` cleanly, because a self-consistent chain over a
 * doctored history is still self-consistent. The evidence of the deletion is
 * the deleted rows, and they are gone.
 *
 * Detection needs a second copy that the attacker does not control.
 * Preservation requires the entries to LEAVE THE MACHINE. That is all this
 * module does: it walks the chain forward in `seq` order and hands each entry
 * to a sink somewhere else, along with both hashes, so the off-box copy can be
 * verified on its own — and so a chain that verifies locally can be compared
 * against a chain that was written down before the attacker arrived. A
 * truncation then shows up as "the off-box copy has entries 1..9000 and the
 * box claims the history is 1..4000", which no local recomputation can hide.
 *
 * NO HOLES, EVER
 *
 * The one invariant worth stating loudly: entries ship in `seq` order and the
 * cursor only ever advances past entries a sink has actually accepted. If
 * entry N fails to ship, N+1 is NOT shipped. Skipping ahead would leave a gap
 * in the off-box copy at exactly the position an attacker would choose, and
 * an off-box copy with holes cannot distinguish "the shipper was flaky" from
 * "someone removed these". Duplicates, by contrast, are harmless: an entry is
 * identified by (company, seq) and carries its own hash, so a receiver can
 * deduplicate. So on any doubt we RE-SHIP rather than skip.
 *
 * REDACTION: WE DO NOT RE-REDACT, AND MUST NOT
 *
 * `appendAuditEvent()` deep-redacts `details` through
 * security/redaction.ts#redactValue *before* storage, and it is the only
 * writer of this table — so what is on disk is already redacted, and there is
 * no unredacted variant to leak here. Re-redacting on the way out would be
 * worse than pointless: the entry hash is taken over the stored
 * `details_json` bytes, so mutating them in flight would produce an off-box
 * copy where every single entry fails verification. That would destroy the
 * only property this module exists to provide. Hence: entries are shipped
 * byte-faithfully, `details_json` included, verbatim.
 *
 * (Sink *error messages* are a different matter — those are strings from an
 * external system heading for the settings UI, and those we do redact.)
 *
 * RUNS AS A SCHEDULED JOB
 *
 * Written for scheduler/scheduler.ts: `shipNewEntries()` does a bounded
 * amount of work, is safe to run late, safe to skip, and safe to run twice in
 * a row (the second run finds nothing new). It reports failure by returning
 * `ok: false` rather than throwing, so the caller can surface a broken sink in
 * the UI; the scheduler's own "a failing job never stops the loop" rule is a
 * backstop, not the primary path.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { allRows, oneRow } from "../domain/sql.ts";
import { redactText } from "../security/redaction.ts";

// ---------------------------------------------------------------------------
// What gets shipped
// ---------------------------------------------------------------------------

/**
 * One audit entry as it leaves the machine.
 *
 * Field names are the storage names, not the camelCase domain names, because
 * this is a wire format for an external verifier — it should read like the row
 * it is, and it should not shift if the TypeScript interfaces are renamed.
 *
 * `details_json` is the canonical JSON STRING exactly as stored, not a parsed
 * object. That is deliberate: `computeEntryHash()` hashes those bytes, so a
 * verifier must see them unaltered. Shipping a parsed object would make
 * verification depend on the receiver reproducing our canonicalisation
 * byte-for-byte, which is a coupling no off-box tool should need.
 */
export interface ShippedAuditEntry {
  /** Stable id of the row, so a receiver can deduplicate on it too. */
  id: string;
  company_id: string;
  seq: number;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  task_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  outcome: string;
  details_json: string;
  correlation_id: string;
  /** Hash of the preceding entry — half of what makes the copy verifiable. */
  prev_hash: string;
  /** Hash of this entry. The other half. This is the entire point. */
  entry_hash: string;
  created_at: number;
}

/** Row shape of the SELECT below. Mirrors the columns 1:1. */
interface AuditRow {
  id: string;
  company_id: string;
  seq: number;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  task_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  outcome: string;
  details_json: string;
  correlation_id: string;
  prev_hash: string;
  entry_hash: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Sink contract
// ---------------------------------------------------------------------------

export interface SinkConnectionStatus {
  ok: boolean;
  /** Human-readable, German, for the settings UI. Never a token or a URL. */
  message: string;
}

/**
 * Result of handing one batch to a sink.
 *
 * `accepted` is the number of LEADING entries the sink durably accepted —
 * leading, because acceptance out of order would be a hole. A sink that
 * cannot tell how much of a batch survived MUST report 0 and let the whole
 * batch be re-shipped; over-reporting is the one failure mode that creates a
 * gap, and a gap is unrecoverable.
 */
export interface AuditShipOutcome {
  accepted: number;
  /** Why the rest did not go. Present whenever `accepted < entries.length`. */
  error?: string;
}

export interface AuditSink {
  /** Stable name; appears in logs and in the shipper's status. */
  readonly kind: string;
  /**
   * Ship one batch, already in ascending `seq` order. Must preserve that
   * order. May throw — a throw is treated as `{ accepted: 0 }`.
   */
  ship(entries: readonly ShippedAuditEntry[]): Promise<AuditShipOutcome>;
  /** Reachability check for the settings UI. Reports, never throws. */
  testConnection(): Promise<SinkConnectionStatus>;
}

/** One NDJSON line per entry, trailing newline included. */
export function toNdjson(entries: readonly ShippedAuditEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// HTTP sink
// ---------------------------------------------------------------------------

export interface HttpAuditSinkOptions {
  /** Collector endpoint that accepts an NDJSON body. */
  url: string;
  /** Optional bearer token. Sent as a header, never placed in a URL or a log. */
  bearerToken?: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POSTs a batch as NDJSON to a collector (Loki, Vector, an S3 gateway, a
 * second IronCrew, a compliance archive — anything that speaks HTTP).
 *
 * All-or-nothing per batch, on purpose. When the response is non-2xx we have
 * no way to know how many lines the far side persisted, so we report 0
 * accepted, the cursor does not move, and the whole batch is retried on the
 * next tick. Re-sending an entry the collector already has is a duplicate the
 * receiver can drop by (company_id, seq); guessing a partial success is a
 * hole nobody can reconstruct.
 */
export class HttpAuditSink implements AuditSink {
  readonly kind = "http" as const;

  private readonly url: string;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAuditSinkOptions) {
    this.url = opts.url;
    this.bearerToken = opts.bearerToken?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    // The token exists in exactly one place: this header. It is never
    // interpolated into the URL, a message or a log line.
    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
    return headers;
  }

  async ship(entries: readonly ShippedAuditEntry[]): Promise<AuditShipOutcome> {
    if (entries.length === 0) return { accepted: 0 };

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers("application/x-ndjson"),
        body: toNdjson(entries),
      });
    } catch (err) {
      // Caught here rather than left to the shipper, which only has the
      // pattern-based redactor. A proxy that puts the request headers into
      // its own failure message hands us a bare token that `redactText`
      // cannot recognise, and this message is logged at warn every tick the
      // sink stays broken and shown by POST /audit/shipping/run.
      // `testConnection()` already guarded its error this way; `ship()` did
      // not, which was an oversight rather than a decision.
      return { accepted: 0, error: this.withoutOwnToken(redactText(errorMessage(err))) };
    }

    if (!res.ok) {
      // The body is the collector's, not ours, so it is truncated and passed
      // through the shared redactor — and then through `withoutOwnToken`,
      // which is the part that is not optional.
      //
      // `redactText` knows the shapes of *known* credentials. It cannot know
      // that this particular string is our bearer token, so a collector that
      // echoes the Authorization header into its error body (Lexware Office
      // documents doing exactly that on a 403, and it is not the only one)
      // would put our token into an error that the scheduler logs at warn
      // every minute and the settings page shows on screen. Found by running
      // it against a collector that echoed, not by reading the code.
      const body = this.withoutOwnToken(redactText((await res.text()).slice(0, 300)));
      return { accepted: 0, error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
    }
    return { accepted: entries.length };
  }

  /**
   * Removes this sink's own bearer token from text on its way out.
   *
   * Applied to everything that can carry remote or system text: a response
   * body, and a transport error, since a failing proxy can put the request
   * headers into its message just as readily as a collector can.
   */
  private withoutOwnToken(text: string): string {
    if (!this.bearerToken) return text;
    return text.split(this.bearerToken).join("«entfernt»");
  }

  async testConnection(): Promise<SinkConnectionStatus> {
    try {
      // An empty NDJSON body: proves the endpoint, the network path and the
      // token all work without writing a fake entry into the archive. An
      // audit archive containing test rows is an audit archive nobody trusts.
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers("application/x-ndjson"),
        body: "",
      });
      if (!res.ok) {
        return { ok: false, message: `Audit-Ziel antwortet mit HTTP ${res.status}.` };
      }
      return { ok: true, message: "Audit-Ziel erreichbar." };
    } catch (err) {
      return {
        ok: false,
        message: `Audit-Ziel nicht erreichbar: ${this.withoutOwnToken(redactText(errorMessage(err)))}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// File sink
// ---------------------------------------------------------------------------

export interface FileAuditSinkOptions {
  /** Target file. Parent directories are created if missing. */
  filePath: string;
}

/**
 * Appends NDJSON to a file — a mounted volume, an NFS share, a directory a log
 * collector tails. The cheapest real off-box sink there is, provided the
 * target is genuinely off-box; pointing this at the same disk buys nothing.
 *
 * PARTIAL WRITES
 *
 * `write(2)` may write fewer bytes than asked, and a full disk or a dropped
 * mount can fail halfway through a batch. Two consequences, both handled here:
 *
 *  1. We write one entry at a time, looping until that entry's bytes are all
 *     out, and count only entries that completed. A batch that dies after
 *     three entries reports `accepted: 3`, the cursor lands on entry 3, and
 *     entry 4 is the first thing tried next run. No hole.
 *
 *  2. A failure *inside* one entry leaves a torn, unparseable half-line at the
 *     end of the file. We accept that: the torn entry is not counted, so it is
 *     re-shipped in full next run, and the reader sees one broken line
 *     followed by the complete entry. A duplicate or a scrap of JSON is
 *     something a reader can drop; a missing entry is not. Truncating the file
 *     back to the last good newline would be the tidier fix and is exactly the
 *     operation we refuse to build — this module never removes bytes from an
 *     audit archive.
 *
 * The fd is opened per batch rather than held open, so log rotation works
 * (O_APPEND is re-resolved each time) and so a crash cannot leave a stale
 * handle. `fsyncSync` before close, because "accepted" has to mean "survives a
 * power cut" — otherwise the cursor advances past entries that never landed.
 */
export class FileAuditSink implements AuditSink {
  readonly kind = "file" as const;

  private readonly filePath: string;

  constructor(opts: FileAuditSinkOptions) {
    this.filePath = opts.filePath;
  }

  async ship(entries: readonly ShippedAuditEntry[]): Promise<AuditShipOutcome> {
    if (entries.length === 0) return { accepted: 0 };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    let fd: number | undefined;
    let accepted = 0;
    let error: string | undefined;
    try {
      fd = fs.openSync(this.filePath, "a");
      for (const entry of entries) {
        const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
        let written = 0;
        while (written < line.length) {
          // A short write is normal, not an error; keep going until this
          // entry is whole. Only then does it count.
          written += fs.writeSync(fd, line, written, line.length - written);
        }
        accepted++;
      }
      fs.fsyncSync(fd);
    } catch (err) {
      error = redactText(errorMessage(err));
      // Whatever was fully written before the failure still needs to be
      // durable, or `accepted` is a promise we did not keep.
      if (fd !== undefined) {
        try {
          fs.fsyncSync(fd);
        } catch {
          // Nothing left to do; report zero rather than over-claim.
          accepted = 0;
        }
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already reported through `error`, if anything went wrong at all.
        }
      }
    }

    return error === undefined ? { accepted } : { accepted, error };
  }

  async testConnection(): Promise<SinkConnectionStatus> {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Open for append and close again: proves the path, the mount and the
      // permissions without adding a byte to the archive.
      const fd = fs.openSync(this.filePath, "a");
      fs.closeSync(fd);
      return { ok: true, message: "Audit-Datei ist beschreibbar." };
    } catch (err) {
      return { ok: false, message: `Audit-Datei nicht beschreibbar: ${redactText(errorMessage(err))}` };
    }
  }
}

// ---------------------------------------------------------------------------
// The shipper
// ---------------------------------------------------------------------------

export const DEFAULT_BATCH_SIZE = 200;
/** Upper bound so one tick cannot monopolise the scheduler on a huge backlog. */
export const DEFAULT_MAX_BATCHES_PER_DRAIN = 20;

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1000;

export interface AuditShipperOptions {
  db: DatabaseSync;
  sink: AuditSink;
  /** How many entries one batch may carry. Clamped to 1..1000. */
  batchSize?: number;
  /** How many batches one `drain()` may ship. Defaults to 20. */
  maxBatchesPerDrain?: number;
  /**
   * Distinguishes cursors when the same database ships to more than one sink.
   * Two sinks sharing a cursor would each see only the entries the other had
   * not already claimed — a hole in both copies.
   */
  cursorNamespace?: string;
}

export interface ShipResult {
  /** False when the sink refused any part of the batch. */
  ok: boolean;
  /** How many entries actually left the machine on this call. */
  shipped: number;
  /** Cursor before this call — the last seq known to be off-box. */
  fromSeq: number;
  /** Cursor after this call. Equals `fromSeq` when nothing was accepted. */
  cursorSeq: number;
  /** How many entries are still waiting after this call. */
  pending: number;
  /** Redacted sink message, when something went wrong. */
  error?: string;
  /**
   * True when the first unshipped entry is not `fromSeq + 1` — i.e. rows below
   * it are gone from the table. Reported, never fatal: see `shipNewEntries`.
   */
  gapDetected: boolean;
}

/**
 * Settings key holding the last seq known to be off-box for one company.
 *
 * Lives in the existing key-value `settings` table rather than a new column or
 * migration: it is per-installation operational bookkeeping, not domain data,
 * and losing it is survivable — a lost cursor means re-shipping, which is
 * duplicates, which is the harmless direction.
 */
export function auditShipperCursorKey(companyId: string, namespace = "default"): string {
  return `ironcrew.audit_shipper.cursor.${namespace}.${companyId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AuditShipper {
  private readonly db: DatabaseSync;
  private readonly sink: AuditSink;
  private readonly batchSize: number;
  private readonly maxBatchesPerDrain: number;
  private readonly namespace: string;

  constructor(opts: AuditShipperOptions) {
    this.db = opts.db;
    this.sink = opts.sink;
    this.batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE), MAX_BATCH_SIZE);
    this.maxBatchesPerDrain = Math.max(opts.maxBatchesPerDrain ?? DEFAULT_MAX_BATCHES_PER_DRAIN, 1);
    this.namespace = opts.cursorNamespace ?? "default";

    // `settings` is created by the base schema in production; this makes the
    // shipper self-contained for domain-only databases (and for tests) without
    // owning a migration. IF NOT EXISTS, and the definition matches
    // modules/bootstrap/schema/base-schema.ts exactly, so it is a no-op on a
    // real installation.
    this.db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  get sinkKind(): string {
    return this.sink.kind;
  }

  /**
   * Whether rows are missing between the cursor and the next entry waiting.
   *
   * The same check `shipNewEntries` performs, answerable without shipping
   * anything, and that difference matters: a gap is the single most alarming
   * thing this module can report — it is the shape a deletion leaves — and
   * until now it was only ever computed during a drain. The scheduler saw it
   * every tick and logged it; the status endpoint never mentioned it, so an
   * operator could only discover it by pressing "übertragen" on a page that
   * gave them no reason to. A signal that needs a click is a signal nobody
   * gets.
   *
   * False when nothing is waiting: with no next entry there is nothing to be
   * missing between, and reporting a gap on an idle installation would train
   * people to ignore the one field that must never be ignored.
   */
  gapAhead(companyId: string): boolean {
    const fromSeq = this.cursor(companyId);
    const next = oneRow<{ seq: number }>(
      this.db.prepare("SELECT MIN(seq) AS seq FROM crew_audit_events WHERE company_id = ? AND seq > ?"),
      companyId,
      fromSeq,
    );
    if (!next || next.seq === null || next.seq === undefined) return false;
    return Number(next.seq) !== fromSeq + 1;
  }

  /** Last seq known to be off-box. 0 means "nothing has ever shipped". */
  cursor(companyId: string): number {
    const row = oneRow<{ value: string }>(
      this.db.prepare("SELECT value FROM settings WHERE key = ?"),
      auditShipperCursorKey(companyId, this.namespace),
    );
    if (!row) return 0;
    const parsed = Number.parseInt(row.value, 10);
    // A corrupt cursor must not be read as "everything already shipped".
    // Falling back to 0 re-ships, which is duplicates; trusting garbage could
    // skip, which is a hole.
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private setCursor(companyId: string, seq: number): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(auditShipperCursorKey(companyId, this.namespace), String(seq));
  }

  /** How many entries are waiting to be shipped for this company. */
  pending(companyId: string): number {
    const row = oneRow<{ n: number }>(
      this.db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE company_id = ? AND seq > ?"),
      companyId,
      this.cursor(companyId),
    );
    return row?.n ?? 0;
  }

  private readBatch(companyId: string, afterSeq: number): ShippedAuditEntry[] {
    // ORDER BY seq ASC is load-bearing, not cosmetic: the cursor is a single
    // watermark, so it is only meaningful if entries are consumed in order.
    const rows = allRows<AuditRow>(
      this.db.prepare(
        `SELECT id, company_id, seq, actor_type, actor_id, action, entity_type, entity_id,
                task_id, run_id, approval_id, outcome, details_json, correlation_id,
                prev_hash, entry_hash, created_at
           FROM crew_audit_events
          WHERE company_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      ),
      companyId,
      afterSeq,
      this.batchSize,
    );
    // The row already is the wire shape; copied explicitly so an added column
    // never starts leaking into the archive unnoticed.
    return rows.map((row) => ({
      id: row.id,
      company_id: row.company_id,
      seq: row.seq,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      task_id: row.task_id,
      run_id: row.run_id,
      approval_id: row.approval_id,
      outcome: row.outcome,
      details_json: row.details_json,
      correlation_id: row.correlation_id,
      prev_hash: row.prev_hash,
      entry_hash: row.entry_hash,
      created_at: row.created_at,
    }));
  }

  /**
   * Ship one bounded batch.
   *
   * The cursor advances to the seq of the last entry the sink ACCEPTED, and
   * not one entry further. That is the no-holes rule from the header made
   * concrete: with `accepted = 3` of 5, entry 4 is where the next call starts,
   * so a failing entry is retried rather than stepped over.
   *
   * Never throws for a sink failure. A collector being down is a Tuesday; the
   * caller (a scheduled job, or the settings UI) wants to see it reported.
   */
  async shipNewEntries(companyId: string): Promise<ShipResult> {
    const fromSeq = this.cursor(companyId);
    const batch = this.readBatch(companyId, fromSeq);

    if (batch.length === 0) {
      return { ok: true, shipped: 0, fromSeq, cursorSeq: fromSeq, pending: 0, gapDetected: false };
    }

    // Rows below the first pending entry are missing. That is either normal
    // (a fresh cursor after an import) or the very tampering this module
    // exists for. Either way, refusing to ship would mean an attacker who
    // deletes one row also stops preservation of everything after it — the
    // worst possible outcome. So: report it, and keep shipping.
    const gapDetected = batch[0].seq !== fromSeq + 1;

    let outcome: AuditShipOutcome;
    try {
      outcome = await this.sink.ship(batch);
    } catch (err) {
      outcome = { accepted: 0, error: errorMessage(err) };
    }

    // A sink over-reporting acceptance is the one bug that creates a hole,
    // so the count is clamped here rather than trusted.
    const accepted = Math.max(0, Math.min(outcome.accepted, batch.length));
    const cursorSeq = accepted > 0 ? batch[accepted - 1].seq : fromSeq;
    if (accepted > 0) this.setCursor(companyId, cursorSeq);

    const error =
      accepted < batch.length ? redactText(outcome.error ?? "Audit-Ziel hat den Batch abgelehnt.") : undefined;

    return {
      ok: accepted === batch.length,
      shipped: accepted,
      fromSeq,
      cursorSeq,
      pending: this.pending(companyId),
      gapDetected,
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Ship batches until nothing is left, the batch limit is reached, or a
   * batch fails. Stopping on the first failure is the no-holes rule again:
   * there is nothing after a failed entry that may legitimately go first.
   */
  async drain(companyId: string): Promise<ShipResult> {
    const fromSeq = this.cursor(companyId);
    let shipped = 0;
    let last: ShipResult = {
      ok: true,
      shipped: 0,
      fromSeq,
      cursorSeq: fromSeq,
      pending: this.pending(companyId),
      gapDetected: false,
    };

    for (let i = 0; i < this.maxBatchesPerDrain; i++) {
      const result = await this.shipNewEntries(companyId);
      shipped += result.shipped;
      last = result;
      if (!result.ok || result.shipped === 0 || result.pending === 0) break;
    }

    return { ...last, fromSeq, shipped };
  }

  /**
   * Reachability check for the settings UI. Reports rather than throwing —
   * a "Verbindung testen" button that throws is a stack trace where a
   * sentence belongs.
   */
  async testConnection(): Promise<SinkConnectionStatus> {
    try {
      return await this.sink.testConnection();
    } catch (err) {
      return { ok: false, message: `Audit-Ziel nicht erreichbar: ${redactText(errorMessage(err))}` };
    }
  }
}
