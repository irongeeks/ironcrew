/**
 * IronCrew — the background work loop.
 *
 * Everything the company does on its own used to need a caller: the run queue
 * drained when someone pressed a button, mailboxes were polled when the
 * Command Center was open, messenger channels when someone asked. That is a
 * program you operate, not a service you run — and the requirement is a
 * service, with nobody's console open.
 *
 * So this is the timer that stands in for that person. It is deliberately a
 * small, boring primitive rather than a job framework:
 *
 *   - **A job never overlaps itself.** A tick that arrives while the previous
 *     one is still running is skipped, not queued behind it. Two concurrent
 *     mailbox polls would race on the same "already seen" bookkeeping and
 *     could create the same task twice; two concurrent drains would fight
 *     over the same leases. Skipping is the only safe answer, and it is also
 *     the honest one: if a job cannot keep up with its interval, running it
 *     twice as often will not help.
 *
 *   - **A failing job never stops the loop.** An unreachable IMAP server is a
 *     Tuesday, not a reason for the queue to stop draining. Errors are
 *     reported and the job is rescheduled.
 *
 *   - **Timers are unref'd.** A service must be able to shut down; a pending
 *     interval that keeps the event loop alive turns `systemctl stop` into a
 *     ninety-second wait for SIGKILL.
 *
 *   - **The clock is injectable.** Tests drive time explicitly rather than
 *     sleeping, so the suite stays fast and deterministic.
 *
 * What it deliberately does NOT do: persistence, distribution, cron
 * expressions, or catch-up for missed ticks. The durable state lives in the
 * run queue (domain/run-request-store.ts) — that is what survives a restart.
 * This loop only decides *when* to look.
 */

import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-scheduler" });

export interface ScheduledJob {
  /** Stable name; appears in logs and in the status endpoint. */
  readonly name: string;
  /** How often to run it. */
  readonly intervalMs: number;
  /**
   * Delay before the first tick. Defaults to a share of the interval so the
   * jobs do not all fire in the same instant at boot — a service that opens
   * four network connections the moment it starts looks like a thundering
   * herd to whatever is on the other end.
   */
  readonly firstDelayMs?: number;
  run(): Promise<void>;
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  runs: number;
  failures: number;
  skipped: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export interface SchedulerOptions {
  jobs: ScheduledJob[];
  /** Injectable for tests. Defaults to the real timer functions. */
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  now?: () => number;
}

interface JobState {
  job: ScheduledJob;
  status: JobStatus;
  timer: { clear(): void } | null;
  inFlight: Promise<void> | null;
}

function defaultSetTimer(fn: () => void, ms: number): { clear(): void } {
  const handle = setTimeout(fn, ms);
  // See the header: an un-unref'd timer keeps the process alive.
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
}

export class Scheduler {
  private readonly states = new Map<string, JobState>();
  private readonly setTimer: (fn: () => void, ms: number) => { clear(): void };
  private readonly now: () => number;
  private started = false;

  constructor(opts: SchedulerOptions) {
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.now = opts.now ?? Date.now;

    for (const job of opts.jobs) {
      if (this.states.has(job.name)) {
        throw new Error(`Duplicate scheduler job name "${job.name}".`);
      }
      if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
        throw new Error(`Job "${job.name}" needs a positive interval, got ${job.intervalMs}.`);
      }
      this.states.set(job.name, {
        job,
        timer: null,
        inFlight: null,
        status: {
          name: job.name,
          intervalMs: job.intervalMs,
          running: false,
          runs: 0,
          failures: 0,
          skipped: 0,
          lastStartedAt: null,
          lastFinishedAt: null,
          lastDurationMs: null,
          lastError: null,
        },
      });
    }
  }

  /** Schedules every job. Idempotent: starting twice does not double-schedule. */
  start(): void {
    if (this.started) return;
    this.started = true;

    let index = 0;
    for (const state of this.states.values()) {
      // Spread the first ticks across the interval rather than firing them
      // together — deterministically, so a restart behaves the same way twice.
      const spread = Math.round((state.job.intervalMs / Math.max(1, this.states.size)) * index);
      this.schedule(state, state.job.firstDelayMs ?? spread);
      index++;
    }
    log.info({ jobs: [...this.states.keys()] }, "scheduler started");
  }

  /**
   * Stops scheduling and waits for whatever is mid-flight.
   *
   * Awaiting matters on shutdown: a drain killed between claiming a request
   * and recording its outcome leaves a lease to expire, which is recoverable
   * but wastes the next few minutes for no reason.
   */
  async stop(): Promise<void> {
    this.started = false;
    for (const state of this.states.values()) {
      state.timer?.clear();
      state.timer = null;
    }
    await Promise.allSettled([...this.states.values()].map((s) => s.inFlight ?? Promise.resolve()));
    log.info("scheduler stopped");
  }

  status(): JobStatus[] {
    return [...this.states.values()].map((s) => ({ ...s.status }));
  }

  /**
   * Runs one job now, outside its schedule.
   *
   * The operator's "do it now" button, and the reason the skip rule is shared
   * with the timer path: triggering a job by hand while it is already running
   * has to be as safe as a tick arriving early.
   */
  async runNow(name: string): Promise<JobStatus> {
    const state = this.states.get(name);
    if (!state) throw new Error(`No scheduler job named "${name}".`);
    await this.tick(state);
    return { ...state.status };
  }

  private schedule(state: JobState, delayMs: number): void {
    state.timer = this.setTimer(() => {
      void this.tick(state).finally(() => {
        // Re-arm only while started, and only after the run finished, so a
        // slow job cannot accumulate a backlog of timers behind itself.
        if (this.started) this.schedule(state, state.job.intervalMs);
      });
    }, delayMs);
  }

  private async tick(state: JobState): Promise<void> {
    if (state.inFlight) {
      state.status.skipped++;
      log.debug({ job: state.job.name, skipped: state.status.skipped }, "job still running; tick skipped");
      return;
    }

    const startedAt = this.now();
    state.status.running = true;
    state.status.lastStartedAt = startedAt;

    const work = (async () => {
      try {
        await state.job.run();
        state.status.runs++;
        state.status.lastError = null;
      } catch (err) {
        state.status.failures++;
        state.status.lastError = err instanceof Error ? err.message : String(err);
        // Logged, never rethrown: see the header — one broken integration
        // must not take the loop down with it.
        log.warn({ job: state.job.name, err: state.status.lastError }, "scheduled job failed");
      } finally {
        state.status.running = false;
        state.status.lastFinishedAt = this.now();
        state.status.lastDurationMs = state.status.lastFinishedAt - startedAt;
        state.inFlight = null;
      }
    })();

    state.inFlight = work;
    await work;
  }
}
