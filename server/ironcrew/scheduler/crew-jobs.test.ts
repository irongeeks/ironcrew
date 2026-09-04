import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { buildCrewJobs, DEFAULT_INTERVALS, intervalsFromEnv, schedulerEnabled } from "./crew-jobs.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Fertig." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

function jobs(over: Parameters<typeof buildCrewJobs>[0] | null = null) {
  return buildCrewJobs(over ?? { orchestrator: orc, companyId });
}

function job(name: string, over: Parameters<typeof buildCrewJobs>[0] | null = null) {
  return jobs(over).find((j) => j.name === name)!;
}

describe("the four jobs", () => {
  it("covers queue, routines, mail, chat and housekeeping", () => {
    expect(jobs().map((j) => j.name)).toEqual(["run-queue", "routines", "mailboxes", "messengers", "sweep"]);
  });

  it("uses the documented defaults, and lets each be overridden", () => {
    expect(job("run-queue").intervalMs).toBe(DEFAULT_INTERVALS.runQueueMs);
    expect(job("run-queue", { orchestrator: orc, companyId, intervals: { runQueueMs: 5000 } }).intervalMs).toBe(5000);
  });
});

describe("run-queue", () => {
  it("turns a delegated task into a finished run without anyone pressing a button", async () => {
    const result = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");

    await job("run-queue").run();

    // This is the whole "runs as a service" claim, in one assertion.
    expect(orc.tasks.get(result.task!.id)!.status).toBe("review");
  });

  it("says nothing and does nothing on an empty queue", async () => {
    const broadcast = vi.fn();
    await job("run-queue", { orchestrator: orc, companyId, broadcast }).run();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("tells the Command Center when it did something", async () => {
    const broadcast = vi.fn();
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");

    await job("run-queue", { orchestrator: orc, companyId, broadcast }).run();

    const types = broadcast.mock.calls.map((c) => c[0]);
    expect(types).toContain("crew_run_queue_changed");
    expect(types).toContain("crew_run_event");
  });
});

describe("messengers", () => {
  function channel(kind: string, over: Record<string, unknown> = {}) {
    return {
      kind,
      poll: async () => [],
      reply: async () => {},
      testConnection: async () => ({ ok: true, message: "" }),
      ...over,
    };
  }

  it("does nothing when no channel is registered", async () => {
    await expect(job("messengers").run()).resolves.toBeUndefined();
  });

  it("keeps polling the other channels when one is unreachable", async () => {
    const good = vi.fn().mockResolvedValue([]);
    orc.registerMessengerChannel(
      channel("telegram", {
        poll: async () => {
          throw new Error("Telegram nicht erreichbar");
        },
      }) as never,
    );
    orc.registerMessengerChannel(channel("discord", { poll: good }) as never);

    // A throw would be caught by the Scheduler too — but it would also skip
    // every channel after the one that failed.
    await expect(job("messengers").run()).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("sweep", () => {
  it("runs clean when there is nothing to sweep", async () => {
    await expect(job("sweep").run()).resolves.toBeUndefined();
  });

  it("frees an agent whose run died without releasing its lease", async () => {
    const agent = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!;
    orc.agentLocks.acquire(agent.id, "run_dead", { ttlMs: 1 });
    db.prepare("UPDATE crew_agents SET run_lock_expires_at = ? WHERE id = ?").run(Date.now() - 60_000, agent.id);

    await job("sweep").run();

    expect(orc.agentLocks.isLocked(agent.id)).toBe(false);
  });
});

describe("configuration from the environment", () => {
  it("is on unless explicitly switched off", () => {
    expect(schedulerEnabled({})).toBe(true);
    expect(schedulerEnabled({ IRONCREW_SCHEDULER: "on" })).toBe(true);
    // A service that has to be switched on to do anything is a service that
    // will be found switched off.
    for (const value of ["off", "OFF", "0", "false", "no", " off "]) {
      expect(schedulerEnabled({ IRONCREW_SCHEDULER: value })).toBe(false);
    }
  });

  it("reads interval overrides in seconds", () => {
    expect(
      intervalsFromEnv({
        IRONCREW_SCHEDULER_QUEUE_SECONDS: "5",
        IRONCREW_SCHEDULER_MAIL_SECONDS: "120",
        IRONCREW_SCHEDULER_MESSENGER_SECONDS: "30",
        IRONCREW_SCHEDULER_SWEEP_SECONDS: "600",
      }),
    ).toEqual({ runQueueMs: 5000, mailboxMs: 120_000, messengerMs: 30_000, sweepMs: 600_000 });
  });

  it("ignores a value that would turn the loop into a hot spin", () => {
    // A typo must not become a one-millisecond loop hammering the database.
    for (const bad of ["0", "-5", "abc", ""]) {
      expect(intervalsFromEnv({ IRONCREW_SCHEDULER_QUEUE_SECONDS: bad })).toEqual({});
    }
  });

  it("leaves untouched intervals at their default", () => {
    expect(intervalsFromEnv({ IRONCREW_SCHEDULER_MAIL_SECONDS: "90" })).toEqual({ mailboxMs: 90_000 });
  });
});

describe("sweep also keeps the queue table from growing forever", () => {
  it("drops a finished request older than the retention window", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    await job("run-queue").run();
    const finished = orc.runRequests.list(companyId)[0];
    expect(finished.status).toBe("done");

    // Age it past the window rather than waiting 30 days.
    db.prepare("UPDATE crew_run_requests SET finished_at = ? WHERE id = ?").run(
      Date.now() - 31 * 24 * 60 * 60_000,
      finished.id,
    );

    await job("sweep").run();
    expect(orc.runRequests.get(finished.id)).toBeNull();
  });

  it("keeps a request that is still live, however old", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    const queued = orc.runRequests.list(companyId)[0];
    db.prepare("UPDATE crew_run_requests SET created_at = ? WHERE id = ?").run(
      Date.now() - 365 * 24 * 60 * 60_000,
      queued.id,
    );

    // Unfinished work is not history, whatever its age.
    await job("sweep").run();
    expect(orc.runRequests.get(queued.id)).not.toBeNull();
  });

  it("honours a shorter retention when one is configured", async () => {
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.");
    await job("run-queue").run();
    const finished = orc.runRequests.list(companyId)[0];
    db.prepare("UPDATE crew_run_requests SET finished_at = ? WHERE id = ?").run(Date.now() - 5000, finished.id);

    await job("sweep", { orchestrator: orc, companyId, queueRetentionMs: 1000 }).run();
    expect(orc.runRequests.get(finished.id)).toBeNull();
  });
});
