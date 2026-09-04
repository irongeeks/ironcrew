import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { TalentStore, TalentMutationError, SENIORITY_LEVELS, type TalentPatch } from "./talent-store.ts";
import { verifyAuditChain } from "./audit.ts";

describe("TalentStore", () => {
  let db: DatabaseSync;
  let companyId: string;
  let store: TalentStore;

  beforeEach(() => {
    db = createTestDb();
    companyId = seedCompany(db);
    store = new TalentStore(db);
  });

  function addTalent(over: Partial<{ key: string; professionalRole: string; seniority: string }> = {}) {
    return store.create({
      companyId,
      key: over.key ?? "cto",
      professionalRole: over.professionalRole ?? "Chief Technology Officer",
      seniority: over.seniority,
    });
  }

  /** Points an existing seeded agent at a talent, the way the org editor would. */
  function bindAgent(agentId: string, talentId: string): void {
    db.prepare("UPDATE crew_agents SET talent_id = ? WHERE id = ?").run(talentId, agentId);
  }

  function columnsOf(table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  describe("create", () => {
    it("stores empty JSON documents rather than nothing", () => {
      const talent = addTalent();
      expect(talent.seniority).toBe("senior");
      expect(talent.role_summary).toBe("");
      expect(JSON.parse(talent.policy_json)).toEqual({});
      expect(JSON.parse(talent.persona_json)).toEqual({});
      expect(JSON.parse(talent.skills_json)).toEqual([]);
    });

    it("serialises policy, persona and skills the caller handed over as objects", () => {
      const talent = store.create({
        companyId,
        key: "cfo",
        professionalRole: "Chief Financial Officer",
        roleSummary: "Zahlen, Budgets, Freigaben",
        seniority: "executive",
        policy: { may_delegate: true, max_risk_level: "medium" },
        persona: { accent: "amber", traits: ["nüchtern"] },
        skills: ["budget-review", " forecast "],
      });

      // The caller never passes a string, so invalid JSON has no way in.
      expect(JSON.parse(talent.policy_json)).toEqual({ may_delegate: true, max_risk_level: "medium" });
      expect(JSON.parse(talent.persona_json)).toEqual({ accent: "amber", traits: ["nüchtern"] });
      expect(JSON.parse(talent.skills_json)).toEqual(["budget-review", "forecast"]);
    });

    it("refuses a second talent with the same key, without a constraint crash", () => {
      addTalent();
      let caught: unknown;
      try {
        addTalent();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TalentMutationError);
      expect((caught as Error).name).toBe("TalentMutationError");
      expect((caught as Error).message).toContain("cto");
      expect((caught as Error).message).not.toContain("UNIQUE constraint");
    });

    it("lets another company use the same key", () => {
      addTalent();
      const other = seedCompany(db, "Other");
      expect(store.create({ companyId: other, key: "cto", professionalRole: "CTO" }).key).toBe("cto");
    });

    it("needs a key and a professional role", () => {
      expect(() => store.create({ companyId, key: " ", professionalRole: "CTO" })).toThrow(TalentMutationError);
      expect(() => store.create({ companyId, key: "cto", professionalRole: "  " })).toThrow(TalentMutationError);
    });

    it("refuses a skill that is not a usable name", () => {
      expect(() => store.create({ companyId, key: "cto", professionalRole: "CTO", skills: ["ok", "  "] })).toThrow(
        TalentMutationError,
      );
    });
  });

  describe("seniority", () => {
    it("accepts every level the crew config already uses", () => {
      for (const level of SENIORITY_LEVELS) {
        expect(addTalent({ key: `k-${level}`, seniority: level }).seniority).toBe(level);
      }
    });

    it("refuses an invented level and names the allowed ones", () => {
      let caught: unknown;
      try {
        addTalent({ seniority: "overlord" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TalentMutationError);
      expect((caught as Error).message).toContain("overlord");
      for (const level of SENIORITY_LEVELS) {
        expect((caught as Error).message).toContain(level);
      }
      expect(store.list(companyId)).toHaveLength(0);
    });

    it("refuses an invented level on update too", () => {
      const talent = addTalent();
      expect(() => store.update(talent.id, { seniority: "overlord" })).toThrow(TalentMutationError);
      expect(store.get(talent.id)).toEqual(talent);
    });
  });

  describe("reads", () => {
    it("finds a talent by id and by key, and null for neither", () => {
      const talent = addTalent();
      expect(store.get(talent.id)?.id).toBe(talent.id);
      expect(store.byKey(companyId, "cto")?.id).toBe(talent.id);
      expect(store.get("tal_nope")).toBeNull();
      expect(store.byKey(companyId, "nope")).toBeNull();
    });

    it("lists only the company's own talents, ordered by key", () => {
      addTalent({ key: "zeta" });
      addTalent({ key: "alpha" });
      const other = seedCompany(db, "Other");
      store.create({ companyId: other, key: "theirs", professionalRole: "CTO" });

      expect(store.list(companyId).map((t) => t.key)).toEqual(["alpha", "zeta"]);
    });
  });

  describe("update", () => {
    it("touches only the keys the patch actually carries", () => {
      const talent = store.create({
        companyId,
        key: "cto",
        professionalRole: "Chief Technology Officer",
        roleSummary: "Technik",
        seniority: "executive",
        policy: { may_delegate: true },
        persona: { accent: "cyan" },
        skills: ["code-review"],
      });

      const updated = store.update(talent.id, { roleSummary: "", persona: { accent: "amber" } })!;

      // Explicitly passed, so written — an empty summary is a decision.
      expect(updated.role_summary).toBe("");
      expect(JSON.parse(updated.persona_json)).toEqual({ accent: "amber" });
      // Omitted, so untouched.
      expect(updated.professional_role).toBe("Chief Technology Officer");
      expect(updated.seniority).toBe("executive");
      expect(JSON.parse(updated.policy_json)).toEqual({ may_delegate: true });
      expect(JSON.parse(updated.skills_json)).toEqual(["code-review"]);
    });

    it("ignores keys it does not own, changing nothing and adding no column", () => {
      const talent = addTalent();
      const before = columnsOf("crew_talents");

      const returned = store.update(talent.id, {
        key: "renamed",
        companyId: "cmp_other",
        timeoutMs: 1,
      } as unknown as TalentPatch);

      expect(returned).toEqual(talent);
      expect(store.get(talent.id)).toEqual(talent);
      expect(columnsOf("crew_talents")).toEqual(before);
    });

    it("returns null for a talent that does not exist", () => {
      expect(store.update("tal_nope", { roleSummary: "x" })).toBeNull();
    });

    it("refuses to blank the professional role", () => {
      const talent = addTalent();
      expect(() => store.update(talent.id, { professionalRole: "   " })).toThrow(TalentMutationError);
    });
  });

  describe("delete", () => {
    it("removes a talent nobody holds", () => {
      const talent = addTalent();
      store.delete(talent.id);
      expect(store.get(talent.id)).toBeNull();
    });

    it("is a no-op for a talent that does not exist", () => {
      expect(() => store.delete("tal_nope")).not.toThrow();
    });

    it("refuses while agents still hold it, naming how many and which", () => {
      const talent = addTalent({ key: "shared-role" });
      bindAgent(seedAgent(db, companyId, "cto"), talent.id);
      bindAgent(seedAgent(db, companyId, "cfo"), talent.id);

      let caught: unknown;
      try {
        store.delete(talent.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TalentMutationError);
      const message = (caught as Error).message;
      expect(message).toContain("2");
      expect(message).toContain("cfo");
      expect(message).toContain("cto");
      expect(message).not.toContain("FOREIGN KEY constraint failed");
      // The refusal must leave the agents with their role intact.
      expect(store.get(talent.id)).not.toBeNull();
      expect(store.agentsFor(talent.id)).toHaveLength(2);
    });

    it("deletes once the last agent has moved off it", () => {
      const talent = addTalent({ key: "shared-role" });
      const agentId = seedAgent(db, companyId, "cto");
      bindAgent(agentId, talent.id);
      expect(() => store.delete(talent.id)).toThrow(TalentMutationError);

      db.prepare("UPDATE crew_agents SET talent_id = NULL WHERE id = ?").run(agentId);
      store.delete(talent.id);
      expect(store.get(talent.id)).toBeNull();
    });
  });

  it("lists the agents holding a talent", () => {
    const talent = addTalent({ key: "shared-role" });
    bindAgent(seedAgent(db, companyId, "cto"), talent.id);
    seedAgent(db, companyId, "cfo");

    expect(store.agentsFor(talent.id).map((a) => a.key)).toEqual(["cto"]);
    expect(store.agentsFor(talent.id)[0].display_name).toBe("CTO");
  });

  it("audits creating, updating and deleting without leaking policy or persona", () => {
    const talent = store.create({
      companyId,
      key: "cto",
      professionalRole: "Chief Technology Officer",
      policy: { allowed_tools: ["Bash"], may_delegate: true },
      persona: { traits: ["geheim"] },
    });
    store.update(talent.id, { persona: { traits: ["immer noch geheim"] }, seniority: "executive" });
    store.delete(talent.id);

    const events = db
      .prepare("SELECT action, details_json FROM crew_audit_events WHERE company_id = ? ORDER BY seq")
      .all(companyId) as Array<{ action: string; details_json: string }>;

    expect(events.map((e) => e.action)).toEqual(["talent.created", "talent.updated", "talent.deleted"]);
    // Which fields moved is enough; what they say is not the audit log's business.
    expect(JSON.parse(events[1].details_json).fields).toEqual(["seniority", "persona"]);
    for (const event of events) {
      expect(event.details_json).not.toContain("geheim");
      expect(event.details_json).not.toContain("Bash");
    }
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
