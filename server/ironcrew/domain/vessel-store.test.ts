import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { VesselStore, VesselMutationError, type VesselPatch } from "./vessel-store.ts";
import { verifyAuditChain } from "./audit.ts";

describe("VesselStore", () => {
  let db: DatabaseSync;
  let companyId: string;
  let store: VesselStore;

  beforeEach(() => {
    db = createTestDb();
    companyId = seedCompany(db);
    store = new VesselStore(db);
  });

  function addVessel(over: Partial<{ key: string; runtimeProvider: string; label: string }> = {}) {
    return store.create({
      companyId,
      key: over.key ?? "claude-default",
      label: over.label ?? "Claude Code (Standard)",
      runtimeProvider: over.runtimeProvider ?? "claude-code",
    });
  }

  /** Points an existing seeded agent at a vessel, the way the org editor would. */
  function bindAgent(agentId: string, vesselId: string): void {
    db.prepare("UPDATE crew_agents SET vessel_id = ? WHERE id = ?").run(vesselId, agentId);
  }

  function columnsOf(table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  describe("create", () => {
    it("falls back to the schema's own limits", () => {
      const vessel = addVessel();
      expect(vessel.timeout_ms).toBe(600000);
      expect(vessel.max_retries).toBe(1);
      expect(vessel.max_concurrency).toBe(1);
      expect(vessel.model).toBe("");
    });

    it("stores the limits it was given", () => {
      const vessel = store.create({
        companyId,
        key: "codex-fast",
        runtimeProvider: "codex",
        model: "gpt-5",
        timeoutMs: 30_000,
        maxRetries: 0,
        maxConcurrency: 4,
      });
      expect(vessel).toMatchObject({
        key: "codex-fast",
        runtime_provider: "codex",
        model: "gpt-5",
        timeout_ms: 30_000,
        max_retries: 0,
        max_concurrency: 4,
      });
    });

    it("refuses a second vessel with the same key, without a constraint crash", () => {
      addVessel();
      let caught: unknown;
      try {
        addVessel();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VesselMutationError);
      expect((caught as Error).name).toBe("VesselMutationError");
      expect((caught as Error).message).toContain("claude-default");
      // The raw SQLite wording is exactly what the store exists to replace.
      expect((caught as Error).message).not.toContain("UNIQUE constraint");
    });

    it("lets another company use the same key", () => {
      addVessel();
      const other = seedCompany(db, "Other");
      expect(store.create({ companyId: other, key: "claude-default", runtimeProvider: "claude-code" }).key).toBe(
        "claude-default",
      );
    });

    it("needs a key and a runtime provider", () => {
      expect(() => store.create({ companyId, key: "  ", runtimeProvider: "codex" })).toThrow(VesselMutationError);
      expect(() => store.create({ companyId, key: "x", runtimeProvider: " " })).toThrow(VesselMutationError);
    });
  });

  describe("limits are validated at the store boundary", () => {
    // A CHECK failure reads "CHECK constraint failed: crew_vessels" — true,
    // and useless to whoever typed the number.
    const bad: Array<[string, VesselPatch]> = [
      ["timeoutMs 0", { timeoutMs: 0 }],
      ["timeoutMs negative", { timeoutMs: -1 }],
      ["maxRetries negative", { maxRetries: -1 }],
      ["maxConcurrency 0", { maxConcurrency: 0 }],
      ["timeoutMs fractional", { timeoutMs: 1.5 }],
    ];

    for (const [name, patch] of bad) {
      it(`refuses ${name} on create`, () => {
        let caught: unknown;
        try {
          store.create({ companyId, key: "v", runtimeProvider: "codex", ...patch });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(VesselMutationError);
        expect((caught as Error).message).not.toContain("CHECK constraint");
        expect(store.list(companyId)).toHaveLength(0);
      });

      it(`refuses ${name} on update`, () => {
        const vessel = addVessel();
        expect(() => store.update(vessel.id, patch)).toThrow(VesselMutationError);
        expect(store.get(vessel.id)).toEqual(vessel);
      });
    }
  });

  describe("reads", () => {
    it("finds a vessel by id and by key, and null for neither", () => {
      const vessel = addVessel();
      expect(store.get(vessel.id)?.id).toBe(vessel.id);
      expect(store.byKey(companyId, "claude-default")?.id).toBe(vessel.id);
      expect(store.get("vsl_nope")).toBeNull();
      expect(store.byKey(companyId, "nope")).toBeNull();
    });

    it("lists only the company's own vessels, ordered by key", () => {
      addVessel({ key: "zeta", runtimeProvider: "mock" });
      addVessel({ key: "alpha", runtimeProvider: "mock" });
      const other = seedCompany(db, "Other");
      store.create({ companyId: other, key: "theirs", runtimeProvider: "mock" });

      expect(store.list(companyId).map((v) => v.key)).toEqual(["alpha", "zeta"]);
    });
  });

  describe("update", () => {
    it("touches only the keys the patch actually carries", () => {
      const vessel = store.create({
        companyId,
        key: "codex-fast",
        label: "Codex",
        runtimeProvider: "codex",
        model: "gpt-5",
        timeoutMs: 30_000,
        maxRetries: 2,
        maxConcurrency: 3,
      });

      const updated = store.update(vessel.id, { timeoutMs: 45_000, model: "" })!;
      expect(updated.timeout_ms).toBe(45_000);
      // Explicitly passed, so it is written — an empty model means "the
      // runtime's own default", not "leave it alone".
      expect(updated.model).toBe("");
      // Omitted, so untouched.
      expect(updated.label).toBe("Codex");
      expect(updated.max_retries).toBe(2);
      expect(updated.max_concurrency).toBe(3);
      expect(updated.runtime_provider).toBe("codex");
    });

    it("returns null for a vessel that does not exist", () => {
      expect(store.update("vsl_nope", { label: "x" })).toBeNull();
    });

    it("refuses to blank the runtime provider", () => {
      const vessel = addVessel();
      expect(() => store.update(vessel.id, { runtimeProvider: "   " })).toThrow(VesselMutationError);
    });
  });

  describe("a vessel carries no authority over what a run may do", () => {
    // THREAT_MODEL T-01: permission modes come from a SandboxGrant minted
    // from an approved ApprovalRequest and capped at four hours. A vessel
    // field saying "elevated" would be a second route to elevation that no
    // approval ever authorised — so update() walks its own allowlist rather
    // than spreading whatever object arrived.
    const smuggled = {
      permission_mode: "bypassPermissions",
      permissionMode: "bypassPermissions",
      allowed_tools: ["Bash"],
      allowedTools: ["Bash"],
      sandbox: false,
      policy_json: '{"may_approve":true}',
      grant_id: "grant_forged",
    };

    it("ignores permission-shaped keys in a patch entirely", () => {
      const vessel = addVessel();
      const before = columnsOf("crew_vessels");

      const returned = store.update(vessel.id, smuggled as unknown as VesselPatch);

      // Nothing written: not the row, not even updated_at.
      expect(returned).toEqual(vessel);
      expect(store.get(vessel.id)).toEqual(vessel);
      // And no column was conjured to hold them.
      expect(columnsOf("crew_vessels")).toEqual(before);
      for (const forbidden of Object.keys(smuggled)) {
        expect(columnsOf("crew_vessels")).not.toContain(forbidden);
      }
    });

    it("still applies the legitimate half of a mixed patch, and only that half", () => {
      const vessel = addVessel();
      const updated = store.update(vessel.id, { label: "Neu", ...smuggled } as unknown as VesselPatch)!;

      expect(updated.label).toBe("Neu");
      expect(Object.keys(updated)).not.toContain("permission_mode");
      expect(columnsOf("crew_vessels")).not.toContain("permission_mode");
    });

    it("writes no audit entry for a patch that changed nothing", () => {
      const vessel = addVessel();
      store.update(vessel.id, smuggled as unknown as VesselPatch);

      const actions = (
        db.prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq").all(companyId) as Array<{
          action: string;
        }>
      ).map((r) => r.action);
      expect(actions).toEqual(["vessel.created"]);
    });
  });

  describe("delete", () => {
    it("removes a vessel nobody runs in", () => {
      const vessel = addVessel();
      store.delete(vessel.id);
      expect(store.get(vessel.id)).toBeNull();
    });

    it("is a no-op for a vessel that does not exist", () => {
      expect(() => store.delete("vsl_nope")).not.toThrow();
    });

    it("refuses while agents still run in it, naming how many and which", () => {
      const vessel = addVessel();
      bindAgent(seedAgent(db, companyId, "cto"), vessel.id);
      bindAgent(seedAgent(db, companyId, "cfo"), vessel.id);

      let caught: unknown;
      try {
        store.delete(vessel.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VesselMutationError);
      const message = (caught as Error).message;
      expect(message).toContain("2");
      expect(message).toContain("cfo");
      expect(message).toContain("cto");
      // Not the answer SQLite would have given.
      expect(message).not.toContain("FOREIGN KEY constraint failed");
      expect(store.get(vessel.id)).not.toBeNull();
    });

    it("deletes once the last agent has moved off it", () => {
      const vessel = addVessel();
      const agentId = seedAgent(db, companyId, "cto");
      bindAgent(agentId, vessel.id);
      expect(() => store.delete(vessel.id)).toThrow(VesselMutationError);

      db.prepare("UPDATE crew_agents SET vessel_id = NULL WHERE id = ?").run(agentId);
      store.delete(vessel.id);
      expect(store.get(vessel.id)).toBeNull();
    });
  });

  it("lists the agents running in a vessel", () => {
    const vessel = addVessel();
    bindAgent(seedAgent(db, companyId, "cto"), vessel.id);
    const other = addVessel({ key: "second", runtimeProvider: "mock" });
    bindAgent(seedAgent(db, companyId, "cfo"), other.id);

    expect(store.agentsFor(vessel.id).map((a) => a.key)).toEqual(["cto"]);
    expect(store.agentsFor(vessel.id)[0].display_name).toBe("CTO");
  });

  it("audits creating, updating and deleting, and the chain stays valid", () => {
    const vessel = addVessel();
    store.update(vessel.id, { maxConcurrency: 2 });
    store.delete(vessel.id);

    const events = db
      .prepare("SELECT action, details_json FROM crew_audit_events WHERE company_id = ? ORDER BY seq")
      .all(companyId) as Array<{ action: string; details_json: string }>;

    expect(events.map((e) => e.action)).toEqual(["vessel.created", "vessel.updated", "vessel.deleted"]);
    expect(JSON.parse(events[1].details_json).fields).toEqual(["maxConcurrency"]);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
