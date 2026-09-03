import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { SecretStore, SecretMutationError } from "./secret-store.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let store: SecretStore;
let companyId: string;

beforeEach(() => {
  db = createTestDb();
  store = new SecretStore(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

describe("create / read", () => {
  it("persists a secret ref — no value column exists to leak", () => {
    const s = store.create({ companyId, name: "github-pat", provider: "vaultwarden", itemRef: "github" });
    expect(s.company_id).toBe(companyId);
    expect(s.provider).toBe("vaultwarden");
    expect(s.item_ref).toBe("github");
    expect(s.field).toBeNull();
    expect(Object.keys(s)).not.toContain("value");
  });

  it("stores an optional field selector", () => {
    const s = store.create({
      companyId,
      name: "github-user",
      provider: "vaultwarden",
      itemRef: "github",
      field: "username",
    });
    expect(s.field).toBe("username");
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid at the type level too
      store.create({ companyId, name: "x", provider: "1password", itemRef: "y" }),
    ).toThrow(SecretMutationError);
  });

  it("rejects an empty name or itemRef", () => {
    expect(() => store.create({ companyId, name: "", provider: "protonpass", itemRef: "s:i" })).toThrow(
      SecretMutationError,
    );
    expect(() => store.create({ companyId, name: "x", provider: "protonpass", itemRef: "" })).toThrow(
      SecretMutationError,
    );
  });

  it("rejects a duplicate name within the same company", () => {
    store.create({ companyId, name: "dup", provider: "protonpass", itemRef: "s:1" });
    expect(() => store.create({ companyId, name: "dup", provider: "protonpass", itemRef: "s:2" })).toThrow(
      SecretMutationError,
    );
  });

  it("allows the same name in a different company", () => {
    const other = seedCompany(db, "Other Co");
    store.create({ companyId, name: "dup", provider: "protonpass", itemRef: "s:1" });
    expect(() => store.create({ companyId: other, name: "dup", provider: "protonpass", itemRef: "s:2" })).not.toThrow();
  });

  it("get returns null for a missing id", () => {
    expect(store.get("secret_nope")).toBeNull();
  });

  it("getByName scopes to the company", () => {
    const other = seedCompany(db, "Other Co");
    store.create({ companyId, name: "shared-name", provider: "protonpass", itemRef: "s:1" });
    expect(store.getByName(other, "shared-name")).toBeNull();
  });

  it("list orders by name and scopes to the company", () => {
    const other = seedCompany(db, "Other Co");
    store.create({ companyId, name: "b", provider: "protonpass", itemRef: "s:1" });
    store.create({ companyId, name: "a", provider: "protonpass", itemRef: "s:2" });
    store.create({ companyId: other, name: "z", provider: "protonpass", itemRef: "s:3" });
    const names = store.list(companyId).map((s) => s.name);
    expect(names).toEqual(["a", "b"]);
  });
});

describe("update", () => {
  it("patches name, itemRef, field and description independently", () => {
    const s = store.create({ companyId, name: "x", provider: "protonpass", itemRef: "s:1" });
    const updated = store.update(s.id, { itemRef: "s:2" });
    expect(updated?.item_ref).toBe("s:2");
    expect(updated?.name).toBe("x");
  });

  it("allows clearing the field back to null", () => {
    const s = store.create({ companyId, name: "x", provider: "vaultwarden", itemRef: "github", field: "username" });
    const updated = store.update(s.id, { field: null });
    expect(updated?.field).toBeNull();
  });

  it("returns null for a missing id", () => {
    expect(store.update("secret_nope", { name: "x" })).toBeNull();
  });

  it("rejects a rename that collides with another secret in the same company", () => {
    store.create({ companyId, name: "a", provider: "protonpass", itemRef: "s:1" });
    const b = store.create({ companyId, name: "b", provider: "protonpass", itemRef: "s:2" });
    expect(() => store.update(b.id, { name: "a" })).toThrow(SecretMutationError);
  });

  it("allows renaming to its own current name (no-op collision)", () => {
    const s = store.create({ companyId, name: "a", provider: "protonpass", itemRef: "s:1" });
    expect(() => store.update(s.id, { name: "a", description: "still a" })).not.toThrow();
  });
});

describe("delete", () => {
  it("deletes an existing secret and returns true", () => {
    const s = store.create({ companyId, name: "x", provider: "protonpass", itemRef: "s:1" });
    expect(store.delete(s.id)).toBe(true);
    expect(store.get(s.id)).toBeNull();
  });

  it("returns false for a missing id", () => {
    expect(store.delete("secret_nope")).toBe(false);
  });
});

describe("audit trail", () => {
  it("audits create, update and delete — and the chain stays valid", () => {
    const s = store.create({ companyId, name: "x", provider: "protonpass", itemRef: "s:1" });
    store.update(s.id, { description: "renamed context" });
    store.delete(s.id);

    const result = verifyAuditChain(db, companyId);
    expect(result.valid).toBe(true);

    const actions = db
      .prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq ASC")
      .all(companyId) as Array<{ action: string }>;
    expect(actions.map((a) => a.action)).toEqual(["secret.registered", "secret.updated", "secret.deleted"]);
  });

  it("never writes a resolved secret value into the audit trail — this store never sees one", () => {
    store.create({ companyId, name: "x", provider: "protonpass", itemRef: "s:1" });
    const rows = db.prepare("SELECT details_json FROM crew_audit_events WHERE company_id = ?").all(companyId) as Array<{
      details_json: string;
    }>;
    for (const row of rows) {
      expect(row.details_json).not.toMatch(/"value"/);
    }
  });
});
