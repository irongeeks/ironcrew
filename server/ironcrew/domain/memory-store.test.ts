import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { MemoryStore, MemoryMutationError } from "./memory-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: MemoryStore;
let companyId: string;
let agentId: string;

beforeEach(() => {
  db = createTestDb();
  store = new MemoryStore(db);
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId, "cto");
});

afterEach(() => db.close());

function input(overrides: Partial<Parameters<MemoryStore["create"]>[0]> = {}) {
  return {
    companyId,
    provider: "obsidian",
    externalId: "note/abc-hello-world",
    kind: "note" as const,
    title: "Hello world",
    ...overrides,
  };
}

describe("create", () => {
  it("records a memory ref with sensible defaults", () => {
    const m = store.create(input());
    expect(m.provider).toBe("obsidian");
    expect(m.external_id).toBe("note/abc-hello-world");
    expect(m.kind).toBe("note");
    expect(m.confidence).toBe(1.0);
    expect(m.sensitivity).toBe("internal");
    expect(m.path).toBeNull();
    expect(m.task_id).toBeNull();
  });

  it("carries provenance and a custom confidence/sensitivity when given", () => {
    const m = store.create(
      input({
        kind: "fact",
        path: "IronCrew/fact/abc-hello-world.md",
        agentId,
        source: "meeting mtg_1",
        confidence: 0.7,
        sensitivity: "confidential",
      }),
    );
    expect(m.kind).toBe("fact");
    expect(m.path).toBe("IronCrew/fact/abc-hello-world.md");
    expect(m.agent_id).toBe(agentId);
    expect(m.source).toBe("meeting mtg_1");
    expect(m.confidence).toBe(0.7);
    expect(m.sensitivity).toBe("confidential");
  });

  it("rejects an unknown kind", () => {
    expect(() => store.create(input({ kind: "invalid" as never }))).toThrow(MemoryMutationError);
  });

  it("rejects an empty title", () => {
    expect(() => store.create(input({ title: "  " }))).toThrow(MemoryMutationError);
  });

  it("rejects a missing provider or externalId", () => {
    expect(() => store.create(input({ provider: "" }))).toThrow(MemoryMutationError);
    expect(() => store.create(input({ externalId: "" }))).toThrow(MemoryMutationError);
  });
});

describe("list and get", () => {
  it("lists memory refs for a company, newest first", () => {
    const a = store.create(input({ externalId: "note/a" }));
    const b = store.create(input({ externalId: "note/b" }));
    const list = store.list(companyId);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("filters by kind, taskId, projectId and agentId", () => {
    store.create(input({ externalId: "note/a", kind: "note" }));
    const fact = store.create(input({ externalId: "note/b", kind: "fact", agentId, taskId: "task_1" }));

    expect(store.list(companyId, { kind: "fact" }).map((r) => r.id)).toEqual([fact.id]);
    expect(store.list(companyId, { taskId: "task_1" }).map((r) => r.id)).toEqual([fact.id]);
    expect(store.list(companyId, { agentId }).map((r) => r.id)).toEqual([fact.id]);
  });

  it("returns null for a missing id", () => {
    expect(store.get("mem_nope")).toBeNull();
  });
});

describe("delete", () => {
  it("removes a memory ref and returns true", () => {
    const m = store.create(input());
    expect(store.delete(m.id)).toBe(true);
    expect(store.get(m.id)).toBeNull();
  });

  it("returns false for a missing id", () => {
    expect(store.delete("mem_nope")).toBe(false);
  });
});

describe("audit trail", () => {
  it("records recording and deletion, with a valid chain", () => {
    const m = store.create(input());
    store.delete(m.id);
    const chain = verifyAuditChain(db, companyId);
    expect(chain.valid).toBe(true);
  });
});
