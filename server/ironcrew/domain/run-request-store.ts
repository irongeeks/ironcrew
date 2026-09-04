/**
 * IronCrew — the queue between "this should run" and "this is running".
 *
 * A task status says what a task *is*. It cannot say how often we have tried
 * to run it, when we may try next, or which attempt failed and why. That state
 * belongs to the attempt, so the attempt gets a row of its own (migration
 * 0016), and this store is the only thing that writes it.
 *
 * Three rules carry the design, and each of them is a rule because the obvious
 * alternative breaks under a second caller:
 *
 *   * **One live request per task is a schema guarantee, not a convention.**
 *     `enqueue` inserts first and treats the unique-index violation as the
 *     expected answer. A select-then-insert would leave a window in which two
 *     ingresses — a mail poll and a manual retry, say — both see nothing and
 *     both write, which is the double run this queue exists to prevent.
 *   * **Claiming is a compare-and-set in the WHERE clause**, exactly as in
 *     `TaskStore.claim()` and `AgentLockStore.acquire()`. The database decides
 *     who wins; the loser sees `changes === 0` and moves on.
 *   * **The hold is a lease, not a lock.** A drain that crashes mid-run must
 *     not strand a request until someone notices, so `claimNext` itself
 *     reclaims an expired lease. `sweepExpired` only makes the same recovery
 *     visible as a number.
 *
 * Retrying is deliberate: `max_attempts` defaults to 1, backoff is exponential
 * and capped, and a request that spends its attempts becomes `dead` rather
 * than looping forever. `dead` means a human has to look, and nothing in here
 * quietly revives such a row.
 *
 * On the `failed` status: the schema allows it, this store never parks a row
 * there. A failed attempt either goes back to `queued` with backoff or ends as
 * `dead`. A resting `failed` row would sit outside the live index (so it does
 * not block a new request), outside the claim query (so nothing picks it up)
 * and outside `prune` (so nothing ever clears it) — a state with no exit.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent } from "./audit.ts";

export const RUN_REQUEST_STATUSES = ["queued", "running", "done", "failed", "dead", "cancelled"] as const;
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number];

/**
 * How long a claim is held before another drain may take it.
 *
 * Longer than a typical run, short enough that a crashed drain does not park a
 * request for a working day. A run that outlives its lease should `renew`.
 */
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/**
 * How long a request waits after it could not start.
 *
 * Short, because "the agent was busy" resolves on its own in the time one run
 * takes — this is a queue behind a lock, not a backoff after an error.
 */
export const DEFAULT_DEFER_MS = 30_000;

/** The statuses the partial unique index counts as live — see migration 0016. */
const LIVE_STATUSES = "('queued','running')";

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/**
 * Deterministic exponential backoff, capped. `attempt` is 1-based.
 *
 * 30s, 1m, 2m, 4m, 8m, then 15m forever. Deliberately without jitter: a single
 * drain per company means there is no thundering herd to spread out, and a
 * caller that can predict the next attempt can also test and explain it.
 */
export function backoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // A large exponent overflows to Infinity, which the cap absorbs unchanged.
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

export interface RunRequestRow {
  id: string;
  company_id: string;
  task_id: string;
  requested_by: string;
  status: RunRequestStatus;
  attempts: number;
  max_attempts: number;
  not_before: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  run_id: string | null;
  last_error: string;
  correlation_id: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const COLUMNS = `id, company_id, task_id, requested_by, status, attempts, max_attempts, not_before,
  lease_owner, lease_expires_at, run_id, last_error, correlation_id, created_at, updated_at, finished_at`;

export class RunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRequestError";
  }
}

export interface EnqueueRunRequestInput {
  companyId: string;
  taskId: string;
  /** Free-form, as in `crew_tasks.created_by`: 'ceo', 'mail:mbx_…', 'messenger:telegram:…'. */
  requestedBy?: string;
  maxAttempts?: number;
  /** Earliest epoch-ms this may be claimed; 0 means immediately. */
  notBefore?: number;
  correlationId?: string;
  now?: number;
}

export interface EnqueueRunRequestResult {
  request: RunRequestRow;
  /**
   * False when a live request for that task already existed. A caller acting
   * on `isNew` alone never dispatches the same task twice.
   */
  isNew: boolean;
}

/** Statuses nothing moves away from. */
function isFinished(status: RunRequestStatus): boolean {
  return status === "done" || status === "failed" || status === "dead" || status === "cancelled";
}

export class RunRequestStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Asks for a task to be run, or recognises that someone already did.
   *
   * The insert goes in blind and the unique index decides. Two ingresses
   * asking for the same task at the same moment is the normal case here, not
   * the exceptional one, so the collision is handled as an outcome rather than
   * an error: the loser reports the winner's row with `isNew: false`.
   *
   * The retry loop covers the narrow window in which the live request finishes
   * between the collision and the lookup — then there is no live row to return
   * and a fresh one is genuinely wanted.
   */
  enqueue(input: EnqueueRunRequestInput): EnqueueRunRequestResult {
    const now = input.now ?? Date.now();
    const requestedBy = input.requestedBy ?? "system";
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 1));
    const notBefore = input.notBefore ?? 0;
    const correlationId = input.correlationId ?? "";
    const id = newId("rreq");

    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      try {
        this.db
          .prepare(
            `INSERT INTO crew_run_requests
               (id, company_id, task_id, requested_by, status, max_attempts, not_before,
                correlation_id, created_at, updated_at)
             VALUES (?,?,?,?,'queued',?,?,?,?,?)`,
          )
          .run(id, input.companyId, input.taskId, requestedBy, maxAttempts, notBefore, correlationId, now, now);
        inserted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed/.test(message)) throw err;
        const live = this.liveForTask(input.taskId);
        if (live) return { request: live, isNew: false };
      }
    }

    if (!inserted) {
      throw new RunRequestError(`Could not enqueue a run request for task "${input.taskId}" after 3 attempts.`);
    }

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: requestedBy === "owner" || requestedBy === "ceo" ? "owner" : "system",
      actorId: requestedBy,
      action: "run_request.enqueued",
      entityType: "run_request",
      entityId: id,
      taskId: input.taskId,
      correlationId,
      // Deliberately no task title or description: the audit log says that a
      // run was asked for, not what the work is about.
      details: { requestedBy, maxAttempts, notBefore },
    });

    return { request: this.get(id)!, isNew: true };
  }

  get(id: string): RunRequestRow | null {
    return oneRow<RunRequestRow>(this.db.prepare(`SELECT ${COLUMNS} FROM crew_run_requests WHERE id = ?`), id);
  }

  /** The one unfinished request for this task, if any — the index guarantees at most one. */
  liveForTask(taskId: string): RunRequestRow | null {
    return oneRow<RunRequestRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_run_requests WHERE task_id = ? AND status IN ${LIVE_STATUSES}`),
      taskId,
    );
  }

  list(companyId: string, opts: { status?: RunRequestStatus; limit?: number } = {}): RunRequestRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    if (opts.status) {
      return allRows<RunRequestRow>(
        this.db.prepare(
          `SELECT ${COLUMNS} FROM crew_run_requests
            WHERE company_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
        ),
        companyId,
        opts.status,
        limit,
      );
    }
    return allRows<RunRequestRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_run_requests WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`),
      companyId,
      limit,
    );
  }

  /**
   * Claims the oldest eligible request for `leaseOwner`, or returns null.
   *
   * Eligible means: due (`not_before` has passed) and either waiting, or
   * `running` under a lease that has expired. The second case is the one that
   * matters — a drain that died mid-run leaves a `running` row nobody owns,
   * and waiting for `sweepExpired` to notice would mean waiting for a caller
   * that may itself be the process that died.
   *
   * The candidate list is only a shortlist. The decision is the guarded
   * UPDATE: it pins the status and the attempt count we observed, so of two
   * drains looking at the same head exactly one wins and the other walks on to
   * the next candidate.
   */
  claimNext(
    companyId: string,
    leaseOwner: string,
    opts: { now?: number; leaseTtlMs?: number } = {},
  ): RunRequestRow | null {
    const now = opts.now ?? Date.now();
    const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

    // A shortlist rather than a single row: under contention the head may be
    // taken by someone else, and re-querying from scratch each time would let
    // two drains ping-pong over the same row while the queue behind it waits.
    const candidates = allRows<{ id: string; status: RunRequestStatus; attempts: number }>(
      this.db.prepare(
        `SELECT id, status, attempts FROM crew_run_requests
          WHERE company_id = ?
            AND not_before <= ?
            AND (status = 'queued'
                 OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
          ORDER BY not_before ASC, created_at ASC
          LIMIT 20`,
      ),
      companyId,
      now,
      now,
    );

    for (const candidate of candidates) {
      const result = this.db
        .prepare(
          `UPDATE crew_run_requests
              SET status = 'running',
                  attempts = attempts + 1,
                  lease_owner = ?,
                  lease_expires_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = ?
              AND attempts = ?
              AND not_before <= ?
              AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(leaseOwner, now + ttl, now, candidate.id, candidate.status, candidate.attempts, now, now);

      // Claims are deliberately not audited: one drain tick per second would
      // drown the log in entries nobody reads. What the run did is audited.
      if (result.changes === 1) return this.get(candidate.id);
    }

    return null;
  }

  /**
   * Extends a lease the caller still holds.
   *
   * False means the request was taken, finished or cancelled underneath — the
   * caller has been displaced and should stop, not retry through it.
   */
  renew(id: string, leaseOwner: string, opts: { now?: number; leaseTtlMs?: number } = {}): boolean {
    const now = opts.now ?? Date.now();
    const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

    const result = this.db
      .prepare(
        `UPDATE crew_run_requests
            SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      )
      .run(now + ttl, now, id, leaseOwner);

    return result.changes === 1;
  }

  /**
   * Marks the request satisfied, naming the run that satisfied it.
   *
   * Refused for a request a human already wrote off: a drain finishing late
   * must not resurrect a `dead` or `cancelled` row. The same guard sits in the
   * WHERE clause too, so a cancellation that lands between the read and the
   * write still wins.
   *
   * `last_error` from an earlier attempt is left in place — it is evidence
   * that this took more than one try, and a success does not make it untrue.
   */
  complete(id: string, opts: { runId?: string | null; now?: number } = {}): RunRequestRow | null {
    const now = opts.now ?? Date.now();
    const request = this.get(id);
    if (!request) return null;
    if (request.status === "done") return request;
    if (isFinished(request.status)) {
      throw new RunRequestError(`Run request "${id}" is ${request.status} and cannot be completed.`);
    }

    this.db
      .prepare(
        `UPDATE crew_run_requests
            SET status = 'done',
                run_id = COALESCE(?, run_id),
                lease_owner = NULL,
                lease_expires_at = NULL,
                finished_at = ?,
                updated_at = ?
          WHERE id = ? AND status IN ${LIVE_STATUSES}`,
      )
      .run(opts.runId ?? null, now, now, id);

    return this.get(id);
  }

  /**
   * Puts a claimed request back without counting the claim as an attempt.
   *
   * This is the "could not start" case, and it is deliberately not `fail`.
   * A drain that claims a request and then finds the agent already busy or
   * the vessel at its concurrency limit has not *tried* to run anything —
   * nothing was dispatched, no runtime was asked, no money was spent. Letting
   * that burn an attempt would dead-letter a perfectly good task for the sole
   * reason that the company was busy, which is precisely when the queue is
   * supposed to be useful.
   *
   * So the claim's increment is undone. Attempts count runs, not claims.
   * The increment still happens *at claim time* rather than at failure time,
   * because a request whose run hangs the process must not be retried
   * forever — for that case the attempt is spent, and correctly so.
   */
  defer(id: string, reason: string, opts: { delayMs?: number; now?: number } = {}): RunRequestRow | null {
    const now = opts.now ?? Date.now();
    const request = this.get(id);
    if (!request) return null;
    if (isFinished(request.status)) {
      throw new RunRequestError(`Run request "${id}" is ${request.status}; it cannot be deferred.`);
    }

    const delay = opts.delayMs ?? DEFAULT_DEFER_MS;
    this.db
      .prepare(
        `UPDATE crew_run_requests
            SET status = 'queued',
                attempts = MAX(0, attempts - 1),
                not_before = ?,
                last_error = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND status IN ${LIVE_STATUSES}`,
      )
      .run(now + delay, reason, now, id);

    return this.get(id);
  }

  /**
   * Records a failed attempt: back to `queued` with backoff, or `dead` when
   * the attempts are spent.
   *
   * `attempts` was already incremented by the claim, so it is the number of
   * tries made — comparing it to `max_attempts` here needs no off-by-one.
   *
   * Refused on a finished request for the same reason `complete` is: a late
   * failure from a displaced drain must not reopen something that was closed.
   */
  fail(id: string, error: string, opts: { now?: number } = {}): RunRequestRow | null {
    const now = opts.now ?? Date.now();
    const request = this.get(id);
    if (!request) return null;
    if (isFinished(request.status)) {
      throw new RunRequestError(`Run request "${id}" is ${request.status}; a late failure cannot reopen it.`);
    }

    const spent = request.attempts >= request.max_attempts;

    if (spent) {
      const result = this.db
        .prepare(
          `UPDATE crew_run_requests
              SET status = 'dead',
                  last_error = ?,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  finished_at = ?,
                  updated_at = ?
            WHERE id = ? AND status IN ${LIVE_STATUSES}`,
        )
        .run(error, now, now, id);

      if (result.changes === 1) {
        appendAuditEvent(this.db, {
          companyId: request.company_id,
          actorType: "system",
          actorId: "scheduler",
          action: "run_request.dead_lettered",
          entityType: "run_request",
          entityId: id,
          taskId: request.task_id,
          runId: request.run_id,
          outcome: "failed",
          correlationId: request.correlation_id,
          // The error text stays on the row and out of the audit log: it can
          // quote run output, and the log is read by people who are not
          // entitled to the run's content.
          details: { attempts: request.attempts, maxAttempts: request.max_attempts },
        });
      }
      return this.get(id);
    }

    this.db
      .prepare(
        `UPDATE crew_run_requests
            SET status = 'queued',
                last_error = ?,
                not_before = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND status IN ${LIVE_STATUSES}`,
      )
      .run(error, now + backoffMs(request.attempts), now, id);

    return this.get(id);
  }

  /**
   * Withdraws a request.
   *
   * A `running` request is cancelled too, not refused. We cannot reach into a
   * drain that is already working, but the point of cancelling is that the
   * result must not be acted on, and that we *can* guarantee: the row goes
   * terminal immediately, and `complete` refuses a `cancelled` row — both
   * before the write and in its WHERE clause — so the drain's late finish is
   * rejected instead of silently undoing the cancellation. Leaving the row
   * `running` and hoping the drain checks back would be the weaker guarantee,
   * because a crashed drain never checks back.
   *
   * Cancelling twice is a no-op rather than an error; cancelling something
   * that already finished is refused, because there is nothing left to
   * withdraw.
   */
  cancel(id: string, opts: { reason?: string; now?: number } = {}): RunRequestRow | null {
    const now = opts.now ?? Date.now();
    const request = this.get(id);
    if (!request) return null;
    if (request.status === "cancelled") return request;
    if (isFinished(request.status)) {
      throw new RunRequestError(`Run request "${id}" is ${request.status} and can no longer be withdrawn.`);
    }

    const result = this.db
      .prepare(
        `UPDATE crew_run_requests
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                finished_at = ?,
                updated_at = ?
          WHERE id = ? AND status IN ${LIVE_STATUSES}`,
      )
      .run(now, now, id);

    if (result.changes === 1) {
      appendAuditEvent(this.db, {
        companyId: request.company_id,
        actorType: "owner",
        actorId: "ceo",
        action: "run_request.cancelled",
        entityType: "run_request",
        entityId: id,
        taskId: request.task_id,
        correlationId: request.correlation_id,
        // The row has no column for a human's reason; the audit entry is where
        // "why did this stop" is supposed to be answered anyway.
        details: { reason: opts.reason ?? "", previousStatus: request.status },
      });
    }

    return this.get(id);
  }

  /**
   * Puts `running` rows whose lease expired back into the queue.
   *
   * Not strictly required — `claimNext` already reclaims an expired lease —
   * but it keeps the rows honest for anything reading them directly, and gives
   * an operator a number rather than a guess about how many drains died
   * holding one.
   *
   * A missing expiry counts as expired: a `running` row without a lease is
   * owned by nobody, and leaving it would be leaving it forever.
   */
  sweepExpired(companyId: string, now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE crew_run_requests
            SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE company_id = ?
            AND status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, companyId, now);

    return Number(result.changes);
  }

  /**
   * Drops finished requests older than `olderThanMs`, returning how many went.
   *
   * Finished only. An unfinished request is outstanding work — pruning it
   * would erase the intent to run without anything ever having run.
   */
  prune(companyId: string, olderThanMs: number, now = Date.now()): number {
    const result = this.db
      .prepare(
        `DELETE FROM crew_run_requests
          WHERE company_id = ?
            AND status IN ('done','dead','cancelled')
            AND finished_at IS NOT NULL
            AND finished_at < ?`,
      )
      .run(companyId, now - olderThanMs);

    return Number(result.changes);
  }
}
