import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { AgentLockStore, DEFAULT_AGENT_LOCK_TTL_MS } from "./agent-lock-store.ts";

let db: DatabaseSync;
let companyId: string;
let agentId: string;
let locks: AgentLockStore;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  locks = new AgentLockStore(db);
});

afterEach(() => db.close());

describe("AgentLockStore", () => {
  it("starts unlocked", () => {
    expect(locks.isLocked(agentId)).toBe(false);
    expect(locks.get(agentId)).toEqual({ agentId, runId: null, expiresAt: null });
  });

  it("lets one run take the lease", () => {
    expect(locks.acquire(agentId, "run_1")).toBe(true);
    expect(locks.isLocked(agentId)).toBe(true);
    expect(locks.get(agentId)?.runId).toBe("run_1");
  });

  it("refuses a second run while the first holds it", () => {
    // The collision the whole module exists for: two different tasks
    // dispatched to one agent at the same moment.
    expect(locks.acquire(agentId, "run_1")).toBe(true);
    expect(locks.acquire(agentId, "run_2")).toBe(false);
    expect(locks.get(agentId)?.runId).toBe("run_1");
  });

  it("lets exactly one of many simultaneous claimants win", () => {
    const results = ["run_a", "run_b", "run_c", "run_d"].map((runId) => locks.acquire(agentId, runId));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("is re-entrant for the run that already holds it", () => {
    // A retry inside one run must not deadlock against itself.
    expect(locks.acquire(agentId, "run_1")).toBe(true);
    expect(locks.acquire(agentId, "run_1")).toBe(true);
  });

  it("does not lock a different agent", () => {
    const other = seedAgent(db, companyId, "coo");
    locks.acquire(agentId, "run_1");

    expect(locks.isLocked(other)).toBe(false);
    expect(locks.acquire(other, "run_2")).toBe(true);
  });

  describe("the lease expires — a crashed run must not park an agent forever", () => {
    it("treats an expired lease as free", () => {
      const t0 = 1_000_000;
      locks.acquire(agentId, "run_1", { now: t0, ttlMs: 1000 });

      expect(locks.acquire(agentId, "run_2", { now: t0 + 500 })).toBe(false);
      expect(locks.acquire(agentId, "run_2", { now: t0 + 1001 })).toBe(true);
      expect(locks.get(agentId)?.runId).toBe("run_2");
    });

    it("does not report an expired lease as live", () => {
      const t0 = 1_000_000;
      locks.acquire(agentId, "run_1", { now: t0, ttlMs: 1000 });

      expect(locks.isLocked(agentId, t0 + 500)).toBe(true);
      expect(locks.isLocked(agentId, t0 + 2000)).toBe(false);
    });

    it("extends the lease on renew", () => {
      const t0 = 1_000_000;
      locks.acquire(agentId, "run_1", { now: t0, ttlMs: 1000 });
      expect(locks.renew(agentId, "run_1", { now: t0 + 900, ttlMs: 1000 })).toBe(true);

      // Without the renew this would have been free at t0+1001.
      expect(locks.acquire(agentId, "run_2", { now: t0 + 1500 })).toBe(false);
    });

    it("refuses to renew a lease that has been taken over", () => {
      const t0 = 1_000_000;
      locks.acquire(agentId, "run_1", { now: t0, ttlMs: 1000 });
      locks.acquire(agentId, "run_2", { now: t0 + 2000 });

      // run_1 has been displaced, and should learn that rather than
      // quietly extending someone else's lease.
      expect(locks.renew(agentId, "run_1", { now: t0 + 2100 })).toBe(false);
      expect(locks.get(agentId)?.runId).toBe("run_2");
    });

    it("uses a default TTL long enough for a real run", () => {
      // A lease shorter than a typical run would displace healthy work.
      expect(DEFAULT_AGENT_LOCK_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
    });
  });

  describe("release is guarded on the owning run", () => {
    it("releases for the run that holds it", () => {
      locks.acquire(agentId, "run_1");
      expect(locks.release(agentId, "run_1")).toBe(true);
      expect(locks.isLocked(agentId)).toBe(false);
    });

    it("does not let a displaced run clear the new owner's lock", () => {
      // The scenario: run_1's lease expires, run_2 takes the agent, then
      // run_1 finally finishes and tidies up. It must not free run_2.
      const t0 = 1_000_000;
      locks.acquire(agentId, "run_1", { now: t0, ttlMs: 1000 });
      locks.acquire(agentId, "run_2", { now: t0 + 2000 });

      expect(locks.release(agentId, "run_1")).toBe(false);
      expect(locks.get(agentId)?.runId).toBe("run_2");
      expect(locks.isLocked(agentId, t0 + 2100)).toBe(true);
    });

    it("is a no-op for a run that never held it", () => {
      expect(locks.release(agentId, "run_never")).toBe(false);
    });
  });

  describe("sweepExpired", () => {
    it("frees only the leases that have actually expired", () => {
      const t0 = 1_000_000;
      const other = seedAgent(db, companyId, "coo");
      locks.acquire(agentId, "run_old", { now: t0, ttlMs: 1000 });
      locks.acquire(other, "run_live", { now: t0, ttlMs: 100_000 });

      expect(locks.sweepExpired(companyId, t0 + 5000)).toBe(1);
      expect(locks.get(agentId)?.runId).toBeNull();
      expect(locks.get(other)?.runId).toBe("run_live");
    });

    it("does not reach into another company", () => {
      const t0 = 1_000_000;
      const otherCompany = seedCompany(db, "Other");
      const otherAgent = seedAgent(db, otherCompany, "cto");
      locks.acquire(otherAgent, "run_x", { now: t0, ttlMs: 1000 });

      expect(locks.sweepExpired(companyId, t0 + 5000)).toBe(0);
      expect(locks.get(otherAgent)?.runId).toBe("run_x");
    });

    it("reports zero when there is nothing to free", () => {
      expect(locks.sweepExpired(companyId)).toBe(0);
    });
  });

  it("returns null for an agent that does not exist", () => {
    expect(locks.get("agt_nope")).toBeNull();
    expect(locks.isLocked("agt_nope")).toBe(false);
    // Acquiring against a missing agent must fail rather than appear to work.
    expect(locks.acquire("agt_nope", "run_1")).toBe(false);
  });
});
