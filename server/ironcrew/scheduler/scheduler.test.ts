/**
 * The properties that make a background loop safe to leave running for months.
 *
 * Time is injected throughout: a scheduler test that sleeps is a scheduler
 * test that is slow and flaky, and neither tells you anything the fake timer
 * does not.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Scheduler, type ScheduledJob } from "./scheduler.ts";

/**
 * A controllable stand-in for setTimeout: nothing fires until the test says so.
 */
class FakeTimers {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  clock = 0;

  readonly setTimer = (fn: () => void, ms: number): { clear(): void } => {
    const id = this.seq++;
    this.pending.set(id, { at: this.clock + ms, fn });
    return { clear: () => this.pending.delete(id) };
  };

  readonly now = (): number => this.clock;

  /** Fires everything due at or before `clock + ms`, oldest first. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    // Bounded: a job that re-arms itself instantly would otherwise spin here
    // forever, and hanging the suite is a worse failure than a wrong count.
    for (let guard = 0; guard < 1000; guard++) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.pending.delete(id);
      this.clock = Math.max(this.clock, timer.at);
      timer.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.clock = target;
  }

  get scheduled(): number {
    return this.pending.size;
  }
}

let timers: FakeTimers;

beforeEach(() => {
  timers = new FakeTimers();
});

function counting(name: string, intervalMs = 1000): ScheduledJob & { calls: number } {
  const job = {
    name,
    intervalMs,
    firstDelayMs: intervalMs,
    calls: 0,
    async run() {
      job.calls++;
    },
  };
  return job;
}

function make(jobs: ScheduledJob[]): Scheduler {
  return new Scheduler({ jobs, setTimer: timers.setTimer, now: timers.now });
}

describe("running on a timer", () => {
  it("runs a job on every interval", async () => {
    const job = counting("a", 1000);
    const scheduler = make([job]);
    scheduler.start();

    await timers.advance(1000);
    expect(job.calls).toBe(1);
    await timers.advance(1000);
    expect(job.calls).toBe(2);
  });

  it("does nothing before it is started", async () => {
    const job = counting("a");
    make([job]);
    await timers.advance(10_000);
    expect(job.calls).toBe(0);
  });

  it("stops when told to", async () => {
    const job = counting("a", 1000);
    const scheduler = make([job]);
    scheduler.start();
    await timers.advance(1000);

    await scheduler.stop();
    await timers.advance(10_000);
    expect(job.calls).toBe(1);
  });

  it("does not double-schedule when started twice", async () => {
    const job = counting("a", 1000);
    const scheduler = make([job]);
    scheduler.start();
    scheduler.start();

    await timers.advance(1000);
    expect(job.calls).toBe(1);
  });

  it("spreads the first tick of several jobs rather than firing them together", () => {
    const scheduler = make([counting("a", 1000), counting("b", 1000)]);
    scheduler.start();
    // Two jobs, two timers, and the point is that they are not both at t+0.
    expect(timers.scheduled).toBe(2);
  });

  it("refuses a job list that cannot work", () => {
    expect(() => make([counting("a"), counting("a")])).toThrow(/Duplicate/);
    expect(() => make([{ name: "bad", intervalMs: 0, run: async () => {} }])).toThrow(/positive interval/);
  });
});

describe("a job never overlaps itself", () => {
  it("skips a tick that arrives while the job is still running", async () => {
    let release!: () => void;
    let started = 0;
    const job: ScheduledJob = {
      name: "slow",
      intervalMs: 1000,
      firstDelayMs: 1000,
      run: () => {
        started++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const scheduler = make([job]);
    scheduler.start();

    await timers.advance(1000);
    expect(started).toBe(1);

    // Force a second tick while the first is still in flight. Two concurrent
    // mailbox polls would race on the same "already seen" bookkeeping.
    await scheduler.runNow("slow");
    expect(started).toBe(1);
    expect(scheduler.status()[0].skipped).toBe(1);

    release();
    await Promise.resolve();
  });

  it("runs again once the previous run finished", async () => {
    const job = counting("a", 1000);
    const scheduler = make([job]);
    scheduler.start();

    await timers.advance(1000);
    await timers.advance(1000);
    expect(job.calls).toBe(2);
    expect(scheduler.status()[0].skipped).toBe(0);
  });
});

describe("a failing job never stops the loop", () => {
  it("keeps scheduling after a throw", async () => {
    let calls = 0;
    const job: ScheduledJob = {
      name: "flaky",
      intervalMs: 1000,
      firstDelayMs: 1000,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("IMAP nicht erreichbar");
      },
    };
    const scheduler = make([job]);
    scheduler.start();

    await timers.advance(1000);
    expect(scheduler.status()[0].failures).toBe(1);
    expect(scheduler.status()[0].lastError).toMatch(/IMAP/);

    // An unreachable mail server is a Tuesday, not a reason for the run queue
    // to stop draining.
    await timers.advance(1000);
    expect(calls).toBe(2);
    expect(scheduler.status()[0].runs).toBe(1);
    expect(scheduler.status()[0].lastError).toBeNull();
  });

  it("does not let one job's failure affect another", async () => {
    const healthy = counting("healthy", 1000);
    const broken: ScheduledJob = {
      name: "broken",
      intervalMs: 1000,
      firstDelayMs: 1000,
      run: async () => {
        throw new Error("kaputt");
      },
    };
    const scheduler = make([broken, healthy]);
    scheduler.start();

    await timers.advance(3000);
    expect(healthy.calls).toBeGreaterThan(0);
  });
});

describe("status and manual runs", () => {
  it("reports what happened per job", async () => {
    const job = counting("a", 1000);
    const scheduler = make([job]);
    scheduler.start();
    await timers.advance(1000);

    const status = scheduler.status()[0];
    expect(status).toMatchObject({ name: "a", intervalMs: 1000, runs: 1, failures: 0, running: false });
    expect(status.lastStartedAt).not.toBeNull();
    expect(status.lastDurationMs).not.toBeNull();
  });

  it("hands out copies, so a caller cannot edit the scheduler's own state", async () => {
    const scheduler = make([counting("a")]);
    scheduler.status()[0].runs = 99;
    expect(scheduler.status()[0].runs).toBe(0);
  });

  it("runs a job on demand", async () => {
    const job = counting("a", 100_000);
    const scheduler = make([job]);
    scheduler.start();

    await scheduler.runNow("a");
    expect(job.calls).toBe(1);
  });

  it("refuses to run a job that does not exist", async () => {
    const scheduler = make([counting("a")]);
    await expect(scheduler.runNow("nope")).rejects.toThrow(/No scheduler job/);
  });

  it("swallows a failure from a manual run the same way a tick does", async () => {
    const scheduler = make([
      {
        name: "broken",
        intervalMs: 1000,
        run: async () => {
          throw new Error("kaputt");
        },
      },
    ]);
    const status = await scheduler.runNow("broken");
    expect(status.failures).toBe(1);
    expect(status.lastError).toBe("kaputt");
  });
});

describe("stopping waits for work in flight", () => {
  it("does not return until the running job finished", async () => {
    let finished = false;
    let release!: () => void;
    const scheduler = make([
      {
        name: "slow",
        intervalMs: 1000,
        firstDelayMs: 1000,
        run: () =>
          new Promise<void>((resolve) => {
            release = () => {
              finished = true;
              resolve();
            };
          }),
      },
    ]);
    scheduler.start();

    const tick = timers.advance(1000);
    await Promise.resolve();

    const stopping = scheduler.stop().then(() => {
      // A drain killed between claiming a request and recording its outcome
      // leaves a lease to expire for no reason.
      expect(finished).toBe(true);
    });

    release();
    await Promise.all([stopping, tick]);
  });
});
