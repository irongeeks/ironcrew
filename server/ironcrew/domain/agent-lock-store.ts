/**
 * IronCrew — the per-agent run lease.
 *
 * `TaskStore.claim()` makes sure two workers never take the same task. This
 * makes sure one agent never has two runs in flight, which is a different
 * collision with different consequences: an agent holds a workspace, a CLI
 * session and a budget, and two concurrent runs share all three. They
 * interleave writes in one working tree, and each clears the pre-dispatch
 * budget gate without seeing the other's spend — a limit checked twice
 * concurrently is a limit enforced once.
 *
 * The mechanics deliberately mirror the task claim, because the reasoning is
 * the same and two different-looking answers to the same question are how
 * subtle bugs get in:
 *
 *   * The condition lives in the `WHERE` clause, so **the database decides**.
 *     No read-then-write, no window between checking and taking.
 *   * It is a **lease, not a lock**: a crashed run must not park an agent
 *     forever, so an expired lease is reclaimable by the next claimant.
 *   * Release is **guarded on the owning run id**, so a late reaper arriving
 *     after its own lease expired cannot clear a fresh owner's lock.
 *
 * Failure is closed: `acquire()` returning false means the run does not start.
 * There is no "proceed anyway" path, because the whole point is that the
 * second run must not happen.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * How long a lease is held before another claimant may take it.
 *
 * Longer than a typical run, short enough that a crashed process does not
 * strand an agent for a working day. A run that outlives its lease should
 * renew (see `renew`), not be silently displaced.
 */
export const DEFAULT_AGENT_LOCK_TTL_MS = 30 * 60_000;

export interface AgentLockState {
  agentId: string;
  runId: string | null;
  expiresAt: number | null;
}

export class AgentLockStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Takes the lease for `runId`, if it is free or expired.
   *
   * Returns false when another live run holds it — the caller must then not
   * start. Re-acquiring with the same `runId` succeeds and extends the lease,
   * so a retry inside one run is not a deadlock against itself.
   */
  acquire(agentId: string, runId: string, opts: { ttlMs?: number; now?: number } = {}): boolean {
    const now = opts.now ?? Date.now();
    const ttl = opts.ttlMs ?? DEFAULT_AGENT_LOCK_TTL_MS;

    const result = this.db
      .prepare(
        `UPDATE crew_agents
            SET run_lock_run_id = ?,
                run_lock_expires_at = ?,
                updated_at = ?
          WHERE id = ?
            AND (run_lock_run_id IS NULL
                 OR run_lock_run_id = ?
                 OR run_lock_expires_at IS NULL
                 OR run_lock_expires_at <= ?)`,
      )
      .run(runId, now + ttl, now, agentId, runId, now);

    return result.changes === 1;
  }

  /**
   * Extends the lease of a run that already holds it.
   *
   * Returns false if the lease has since been taken by another run — which
   * the caller should treat as "I have been displaced", not as a transient
   * error to retry through.
   */
  renew(agentId: string, runId: string, opts: { ttlMs?: number; now?: number } = {}): boolean {
    const now = opts.now ?? Date.now();
    const ttl = opts.ttlMs ?? DEFAULT_AGENT_LOCK_TTL_MS;

    const result = this.db
      .prepare(
        `UPDATE crew_agents
            SET run_lock_expires_at = ?, updated_at = ?
          WHERE id = ? AND run_lock_run_id = ?`,
      )
      .run(now + ttl, now, agentId, runId);

    return result.changes === 1;
  }

  /**
   * Releases the lease, but only if `runId` still owns it.
   *
   * The guard is the point: a run whose lease expired, and whose agent was
   * then claimed by a newer run, must not clear the newer run's lock when it
   * finally finishes and tidies up.
   */
  release(agentId: string, runId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE crew_agents
            SET run_lock_run_id = NULL, run_lock_expires_at = NULL, updated_at = ?
          WHERE id = ? AND run_lock_run_id = ?`,
      )
      .run(Date.now(), agentId, runId);

    return result.changes === 1;
  }

  /** The current lease, for diagnostics and the agent detail view. */
  get(agentId: string): AgentLockState | null {
    const row = this.db
      .prepare("SELECT id, run_lock_run_id, run_lock_expires_at FROM crew_agents WHERE id = ?")
      .get(agentId) as { id: string; run_lock_run_id: string | null; run_lock_expires_at: number | null } | undefined;
    if (!row) return null;
    return { agentId: row.id, runId: row.run_lock_run_id, expiresAt: row.run_lock_expires_at };
  }

  /** Whether a live lease is held right now (an expired one is not live). */
  isLocked(agentId: string, now = Date.now()): boolean {
    const state = this.get(agentId);
    if (!state?.runId) return false;
    return state.expiresAt !== null && state.expiresAt > now;
  }

  /**
   * Clears leases whose expiry has passed, returning how many were freed.
   *
   * Not strictly required — `acquire()` already treats an expired lease as
   * free — but it keeps the agent rows honest for anything that reads them
   * directly, and gives an operator a number rather than a guess about how
   * many runs died holding one.
   */
  sweepExpired(companyId: string, now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE crew_agents
            SET run_lock_run_id = NULL, run_lock_expires_at = NULL, updated_at = ?
          WHERE company_id = ?
            AND run_lock_run_id IS NOT NULL
            AND run_lock_expires_at IS NOT NULL
            AND run_lock_expires_at <= ?`,
      )
      .run(now, companyId, now);

    return Number(result.changes);
  }
}
