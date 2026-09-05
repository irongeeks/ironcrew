import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { CompanyPolicyStore } from "./company-policy-store.ts";
import { getVendorPolicy, type VendorPolicy } from "./vendor-policy.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { UserStore } from "../auth/user-store.ts";
let db: DatabaseSync, companyId: string, store: CompanyPolicyStore, baseline: VendorPolicy;
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  baseline = structuredClone(getVendorPolicy());
  store = new CompanyPolicyStore(db, () => structuredClone(baseline));
});
afterEach(() => db.close());
function input() {
  const snapshot = store.snapshot(companyId);
  return {
    baseRevision: snapshot.revision,
    baselineFingerprint: snapshot.baselineFingerprint,
    reason: "Nur freigegebene Anbieter für die Firma.",
    restrictions: {
      allowedFamilies: [baseline.allowed_families[0]],
      allowedProviders: [baseline.openrouter.allowed_providers[0]],
    },
  };
}
it("persists scoped restrictions and linked audit without weakening immutable policy", () => {
  const saved = store.save(companyId, input(), "ceo");
  expect(saved.revision).toBe(1);
  expect(saved.effectivePolicy.blocked_families).toEqual(baseline.blocked_families);
  expect(saved.effectivePolicy.blocked_endpoints).toEqual(baseline.blocked_endpoints);
  expect(saved.effectivePolicy.openrouter.sensitive_defaults).toEqual(baseline.openrouter.sensitive_defaults);
  expect(saved.effectivePolicy.telemetry).toEqual(baseline.telemetry);
  expect(new CompanyPolicyStore(db).effective(companyId).allowed_families).toEqual(
    input().restrictions.allowedFamilies,
  );
  const other = seedCompany(db, "other");
  expect(store.snapshot(other).revision).toBe(0);
  expect(store.effective(other)).toEqual(baseline);
  const history = saved.history[0];
  expect(db.prepare("SELECT correlation_id FROM crew_audit_events WHERE id=?").get(history.auditEventId)).toMatchObject(
    { correlation_id: history.correlationId },
  );
  expect(verifyAuditChain(db, companyId).valid).toBe(true);
});
it("rejects stale editors, expanded families/providers, unknown security fields and secrets", () => {
  const first = input();
  store.save(companyId, first, "ceo");
  expect(() => store.save(companyId, first, "ceo")).toThrow("inzwischen");
  for (const restrictions of [
    { allowedFamilies: ["deepseek/*"], allowedProviders: [] },
    { allowedFamilies: [], allowedProviders: ["UnapprovedHost"] },
  ])
    expect(() => store.save(companyId, { ...input(), restrictions }, "ceo")).toThrow("nicht erweitern");
  expect(() => store.save(companyId, { ...input(), telemetry: { enabled: true } }, "ceo")).toThrow();
  expect(() =>
    store.save(companyId, { ...input(), reason: "API key sk-abcdefghijklmnopqrstuvwxyz1234567890" }, "ceo"),
  ).toThrow();
  expect(store.snapshot(companyId).history).toHaveLength(1);
});
it("allows intentional deny-all and dynamically intersects a tightened operator baseline", () => {
  const draft = input();
  store.save(companyId, draft, "ceo");
  const next = input();
  baseline.allowed_families = ["anthropic/*"];
  baseline.openrouter.allowed_providers = ["ChangedHost"];
  expect(store.effective(companyId).allowed_families).toEqual([]);
  expect(store.effective(companyId).openrouter.allowed_providers).toEqual([]);
  expect(() => store.save(companyId, next, "ceo")).toThrow("YAML");
  const saved = store.save(
    companyId,
    { ...input(), restrictions: { allowedFamilies: [], allowedProviders: [] } },
    "ceo",
  );
  expect(saved.effectivePolicy.allowed_families).toEqual([]);
  expect(saved.effectivePolicy.openrouter.allowed_providers).toEqual([]);
});
it("rolls back both revision and audit when persistence fails", () => {
  db.exec(
    "CREATE TRIGGER reject_policy BEFORE INSERT ON crew_company_policy_revisions BEGIN SELECT RAISE(ABORT,'test failure'); END;",
  );
  expect(() => store.save(companyId, input(), "ceo")).toThrow("test failure");
  expect(store.snapshot(companyId).revision).toBe(0);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE action='vendor_policy.updated'").get(),
  ).toMatchObject({ n: 0 });
});
it("requires a live owner at the domain boundary once identities exist", async () => {
  const users = new UserStore(db);
  const owner = await users.create({ email: "owner@example.invalid", password: "test-password-safe", role: "owner" });
  const operator = await users.create({
    email: "operator@example.invalid",
    password: "test-password-safe",
    role: "operator",
  });
  expect(() => store.save(companyId, input(), operator.id)).toThrow("Owner");
  expect(() => store.save(companyId, input(), "ceo")).toThrow("Owner");
  expect(store.save(companyId, input(), owner.id).history[0].createdBy).toBe(owner.id);
});

it("survives reopening the SQLite file and rejects a second connection's stale revision", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ironcrew-policy-"));
  const filename = path.join(directory, "company.sqlite");
  const firstDb = createTestDb(filename);
  let secondDb: DatabaseSync | undefined;
  try {
    const id = seedCompany(firstDb);
    const first = new CompanyPolicyStore(firstDb);
    const snapshot = first.snapshot(id);
    const draft = {
      baseRevision: 0,
      baselineFingerprint: snapshot.baselineFingerprint,
      reason: "Alle Provider bis zur Prüfung sperren.",
      restrictions: { allowedFamilies: [], allowedProviders: [] },
    };
    secondDb = new DatabaseSync(filename);
    const second = new CompanyPolicyStore(secondDb);
    expect(second.snapshot(id).revision).toBe(0);
    first.save(id, draft, "ceo");
    expect(() => second.save(id, draft, "ceo")).toThrow("inzwischen");
    secondDb.close();
    secondDb = undefined;
    firstDb.close();
    secondDb = new DatabaseSync(filename);
    const reopened = new CompanyPolicyStore(secondDb).snapshot(id);
    expect(reopened.revision).toBe(1);
    expect(reopened.effectivePolicy.allowed_families).toEqual([]);
    expect(reopened.history[0].reason).toBe(draft.reason);
    expect(verifyAuditChain(secondDb, id).valid).toBe(true);
  } finally {
    if (firstDb.isOpen) firstDb.close();
    secondDb?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
