import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { RemoteWorkerStore, RemoteWorkerMutationError } from "./remote-worker-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: RemoteWorkerStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new RemoteWorkerStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

function input(overrides: Partial<Parameters<RemoteWorkerStore["create"]>[0]> = {}) {
  return {
    companyId,
    label: "tier0-acme",
    environment: "customer:acme",
    host: "100.64.1.2",
    sshUser: "deploy",
    privateKeyPath: "/etc/ironcrew/keys/acme.pem",
    ...overrides,
  };
}

describe("create / read", () => {
  it("persists a remote worker with sensible defaults — never a key blob", () => {
    const w = store.create(input());
    expect(w.company_id).toBe(companyId);
    expect(w.port).toBe(22);
    expect(w.known_hosts_policy).toBe("strict");
    expect(Object.keys(w)).not.toContain("private_key");
    expect(w.private_key_path).toBe("/etc/ironcrew/keys/acme.pem");
  });

  it("accepts an explicit port and known_hosts_policy", () => {
    const w = store.create(input({ port: 2222, knownHostsPolicy: "accept" }));
    expect(w.port).toBe(2222);
    expect(w.known_hosts_policy).toBe("accept");
  });

  it("rejects an empty label, host, sshUser or privateKeyPath", () => {
    expect(() => store.create(input({ label: "  " }))).toThrow(RemoteWorkerMutationError);
    expect(() => store.create(input({ host: "" }))).toThrow(RemoteWorkerMutationError);
    expect(() => store.create(input({ sshUser: "" }))).toThrow(RemoteWorkerMutationError);
    expect(() => store.create(input({ privateKeyPath: "" }))).toThrow(RemoteWorkerMutationError);
  });

  it("rejects a duplicate label within the same company", () => {
    store.create(input());
    expect(() => store.create(input())).toThrow(RemoteWorkerMutationError);
  });

  it("allows the same label in a different company", () => {
    const other = seedCompany(db, "Other Co");
    store.create(input());
    expect(() => store.create(input({ companyId: other }))).not.toThrow();
  });

  it("get returns null for a missing id", () => {
    expect(store.get("worker_nope")).toBeNull();
  });

  it("list orders by label and scopes to the company", () => {
    const other = seedCompany(db, "Other Co");
    store.create(input({ label: "b" }));
    store.create(input({ label: "a" }));
    store.create(input({ companyId: other, label: "z" }));
    expect(store.list(companyId).map((w) => w.label)).toEqual(["a", "b"]);
  });
});

describe("delete", () => {
  it("deletes an existing worker and returns true", () => {
    const w = store.create(input());
    expect(store.delete(w.id)).toBe(true);
    expect(store.get(w.id)).toBeNull();
  });

  it("returns false for a missing id", () => {
    expect(store.delete("worker_nope")).toBe(false);
  });
});

describe("audit trail", () => {
  it("audits registration and deletion, and the chain stays valid", () => {
    const w = store.create(input());
    store.delete(w.id);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);

    const actions = db
      .prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC")
      .all(companyId) as Array<{ action: string }>;
    expect(actions.map((a) => a.action)).toEqual(["remote_worker.registered", "remote_worker.deleted"]);
  });
});
