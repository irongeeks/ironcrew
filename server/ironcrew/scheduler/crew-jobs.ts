/**
 * IronCrew — what the service does while nobody is watching.
 *
 * The Scheduler (scheduler.ts) knows nothing about IronCrew; this is the list
 * of things worth doing on a timer, and the reasoning for each interval.
 *
 * All four are safe to skip, safe to run late, and safe to run twice in a row.
 * That is not an accident — it is the property that lets the loop stay as
 * simple as it is. Anything that needed exactly-once execution belongs in the
 * run queue, which has leases and attempts for precisely that reason.
 */

import type { CompanyOrchestrator } from "../orchestrator/company.ts";
import type { ScheduledJob } from "./scheduler.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-scheduler" });

export interface CrewJobIntervals {
  /** How often to turn queued run requests into runs. */
  runQueueMs: number;
  /** How often to ask mailboxes whose own interval elapsed for new mail. */
  mailboxMs: number;
  /** How often to fetch new chat messages. */
  messengerMs: number;
  /** How often to clean up leases nobody released. */
  sweepMs: number;
}

export const DEFAULT_INTERVALS: CrewJobIntervals = {
  // Short: this is the latency between "the EA delegated something" and "an
  // agent starts on it", which is the responsiveness a person actually feels.
  runQueueMs: 15_000,
  // The mailbox rows carry their own poll interval and `listPollable` honours
  // it; this only decides how often that question gets asked, so it can be
  // frequent without meaning "poll every mailbox every minute".
  mailboxMs: 60_000,
  // A chat message should not sit for minutes — someone is waiting for a
  // reply — but each tick is a real API call per channel.
  messengerMs: 20_000,
  // Housekeeping. Nothing breaks if it is late, because both the agent lock
  // and the run request treat an expired lease as expired whether or not
  // anyone swept it; sweeping only makes the state legible.
  sweepMs: 300_000,
};

export interface CrewJobOptions {
  orchestrator: CompanyOrchestrator;
  companyId: string;
  intervals?: Partial<CrewJobIntervals>;
  /** How many run requests one drain tick may start. */
  drainLimit?: number;
  /** Broadcast hook, so the Command Center sees background work live. */
  broadcast?: (type: string, payload: unknown) => void;
}

export function buildCrewJobs(opts: CrewJobOptions): ScheduledJob[] {
  const { orchestrator, companyId } = opts;
  const intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
  const broadcast = opts.broadcast ?? (() => {});

  return [
    {
      name: "run-queue",
      intervalMs: intervals.runQueueMs,
      async run() {
        const result = await orchestrator.drainRunQueue(companyId, {
          limit: opts.drainLimit ?? 3,
          onEvent: (event) => broadcast("crew_run_event", event),
        });
        if (result.claimed > 0) {
          log.info(result, "run queue drained");
          broadcast("crew_run_queue_changed", result);
          broadcast("crew_task_changed", {});
        }
      },
    },
    {
      name: "mailboxes",
      intervalMs: intervals.mailboxMs,
      async run() {
        const results = await orchestrator.pollDueMailboxes(companyId);
        if (results.length === 0) return;
        const created = results.reduce((sum, r) => sum + r.tasksCreated, 0);
        log.info({ mailboxes: results.length, tasksCreated: created }, "mailboxes polled");
        broadcast("crew_mailbox_changed", { polled: results.length });
        if (created > 0) broadcast("crew_task_changed", {});
      },
    },
    {
      name: "messengers",
      intervalMs: intervals.messengerMs,
      async run() {
        for (const kind of orchestrator.listMessengerChannelKinds()) {
          // One unreachable channel must not stop the others; the scheduler
          // would catch a throw here, but it would also skip every channel
          // after the one that failed.
          try {
            const result = await orchestrator.pollMessengerChannel(companyId, kind);
            if (result.received > 0) {
              log.info({ kind, ...result }, "messenger polled");
              broadcast("crew_messenger_changed", { kind, ...result });
              for (const taskId of result.taskIds) broadcast("crew_task_changed", { taskId });
            }
          } catch (err) {
            log.warn({ kind, err: err instanceof Error ? err.message : String(err) }, "messenger poll failed");
          }
        }
      },
    },
    {
      name: "sweep",
      intervalMs: intervals.sweepMs,
      async run() {
        const locks = orchestrator.agentLocks.sweepExpired(companyId);
        const requests = orchestrator.runRequests.sweepExpired(companyId);
        if (locks > 0 || requests > 0) log.info({ locks, requests }, "expired leases swept");
      },
    },
  ];
}

/**
 * Reads the scheduler's configuration from the environment.
 *
 * Default is **on**: a service that has to be switched on to do anything is a
 * service that will be found switched off. `IRONCREW_SCHEDULER=off` is for the
 * cases where it genuinely must not run — a second instance sharing one
 * database, or a developer who does not want their laptop polling a live
 * mailbox.
 */
export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.IRONCREW_SCHEDULER ?? "on").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(value);
}

/** Interval overrides, in seconds, for operators who want a different cadence. */
export function intervalsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<CrewJobIntervals> {
  const seconds = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    // A typo must not silently become a one-millisecond loop hammering the
    // database; an unusable value falls back to the default and says so.
    if (!Number.isFinite(parsed) || parsed <= 0) {
      log.warn({ name, value: raw }, "ignoring unusable scheduler interval");
      return undefined;
    }
    return Math.round(parsed * 1000);
  };

  const overrides: Partial<CrewJobIntervals> = {};
  const queue = seconds("IRONCREW_SCHEDULER_QUEUE_SECONDS");
  const mail = seconds("IRONCREW_SCHEDULER_MAIL_SECONDS");
  const messenger = seconds("IRONCREW_SCHEDULER_MESSENGER_SECONDS");
  const sweep = seconds("IRONCREW_SCHEDULER_SWEEP_SECONDS");
  if (queue !== undefined) overrides.runQueueMs = queue;
  if (mail !== undefined) overrides.mailboxMs = mail;
  if (messenger !== undefined) overrides.messengerMs = messenger;
  if (sweep !== undefined) overrides.sweepMs = sweep;
  return overrides;
}
