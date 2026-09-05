import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { CompanyConfigurationStore } from "./company-configuration-store.ts";
import { DEFAULT_COMPANY_CONFIGURATION } from "../../../src/shared/company-configuration.ts";
import { ToolStore } from "../domain/tool-store.ts";
import { ApprovalEngine, ALWAYS_APPROVAL_REQUIRED } from "./approval-policy.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { UserStore } from "../auth/user-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { TaskStore } from "../domain/task-store.ts";
let db: DatabaseSync, store: CompanyConfigurationStore, companyId: string;
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  store = new CompanyConfigurationStore(db);
});
afterEach(() => db.close());
function draft() {
  return {
    baseRevision: store.snapshot(companyId).revision,
    reason: "Kapazität und Freigaben prüfen.",
    configuration: store.effective(companyId),
  };
}
it("persists scoped revisions, defaults and linked audit atomically", () => {
  expect(store.effective(companyId)).toEqual(DEFAULT_COMPANY_CONFIGURATION);
  const input = draft();
  input.configuration.runtime.maxConcurrentRuns = 2;
  const saved = store.save(companyId, input, "ceo");
  expect(saved).toMatchObject({ revision: 1, canEdit: true, configuration: { runtime: { maxConcurrentRuns: 2 } } });
  expect(new CompanyConfigurationStore(db).effective(companyId).runtime.maxConcurrentRuns).toBe(2);
  const other = seedCompany(db, "other");
  expect(store.effective(other)).toEqual(DEFAULT_COMPANY_CONFIGURATION);
  expect(verifyAuditChain(db, companyId).valid).toBe(true);
  const history = saved.history[0];
  expect(db.prepare("SELECT correlation_id FROM crew_audit_events WHERE id=?").get(history.auditEventId)).toMatchObject(
    { correlation_id: history.correlationId },
  );
  expect(() => store.save(companyId, input, "ceo")).toThrow("inzwischen");
  db.exec(
    "CREATE TRIGGER reject_configuration BEFORE INSERT ON crew_company_configuration_revisions BEGIN SELECT RAISE(ABORT,'test failure'); END;",
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events").get();
  expect(() => store.save(companyId, draft(), "ceo")).toThrow("test failure");
  expect(store.snapshot(companyId).revision).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events").get()).toEqual(count);
});
it("rejects untrusted shapes, unknown tools, secrets, invalid limits and nonowners", async () => {
  expect(() =>
    store.save(companyId, { ...draft(), configuration: { ...draft().configuration, secrets: "bad" } }, "ceo"),
  ).toThrow();
  const unknown = draft();
  unknown.configuration.tools.blockedToolKeys = ["uninstalled.tool"];
  expect(() => store.save(companyId, unknown, "ceo")).toThrow("registrierte");
  const invalid = draft();
  invalid.configuration.runtime.maxConcurrentRuns = 0;
  expect(() => store.save(companyId, invalid, "ceo")).toThrow();
  expect(() =>
    store.save(companyId, { ...draft(), reason: "API key sk-abcdefghijklmnopqrstuvwxyz1234567890" }, "ceo"),
  ).toThrow();
  const users = new UserStore(db);
  const owner = await users.create({ email: "owner@example.invalid", password: "safe-test-password", role: "owner" });
  const viewer = await users.create({
    email: "viewer@example.invalid",
    password: "safe-test-password",
    role: "viewer",
  });
  for (const actor of ["ceo", viewer.id, "unknown"])
    expect(() => store.save(companyId, draft(), actor)).toThrow("Owner");
  expect(store.snapshot(companyId, viewer.id).canEdit).toBe(false);
  expect(store.save(companyId, draft(), owner.id).revision).toBe(1);
  db.prepare("UPDATE crew_users SET status='disabled' WHERE id=?").run(owner.id);
  expect(() => store.save(companyId, draft(), owner.id)).toThrow("Owner");
});
it("enforces tool blocklists and approval escalation over explicit grants without weakening the floor", () => {
  const agentId = seedAgent(db, companyId),
    tools = new ToolStore(db);
  const tool = tools.register({ companyId, key: "web.search", riskClass: "read" });
  tools.grant({ toolId: tool.id, agentId, requiresApproval: false });
  expect(tools.resolve(companyId, agentId, tool.key)).toMatchObject({ allowed: true, requiresApproval: false });
  const input = draft();
  input.configuration.approvals.additionalRequiredTypes = [tool.key];
  store.save(companyId, input, "ceo");
  expect(tools.resolve(companyId, agentId, tool.key)).toMatchObject({ allowed: true, requiresApproval: true });
  const approval = new ApprovalEngine(db);
  expect(() => approval.assertActionPermitted(companyId, tool.key, null)).toThrow("blocked");
  const risk = draft();
  risk.configuration.approvals.additionalRequiredTypes = [];
  risk.configuration.tools.requireApprovalForRiskClasses = ["read"];
  store.save(companyId, risk, "ceo");
  expect(tools.resolve(companyId, agentId, tool.key)).toMatchObject({ allowed: true, requiresApproval: true });
  const blocked = draft();
  blocked.configuration.tools.blockedToolKeys = [tool.key];
  store.save(companyId, blocked, "ceo");
  expect(tools.resolve(companyId, agentId, tool.key)).toMatchObject({ allowed: false, reason: "disabled" });
  const reset = draft();
  reset.configuration = structuredClone(DEFAULT_COMPANY_CONFIGURATION);
  store.save(companyId, reset, "ceo");
  for (const type of ALWAYS_APPROVAL_REQUIRED)
    expect(() => approval.assertActionPermitted(companyId, type, null)).toThrow("blocked");
  expect(tools.resolve(companyId, agentId, tool.key)).toMatchObject({ allowed: true, requiresApproval: false });
});
it("shares persisted capacity across tasks and meetings, releases and expires leases", () => {
  const input = draft();
  input.configuration.runtime.maxConcurrentRuns = 1;
  store.save(companyId, input, "ceo");
  const now = Date.now(),
    stale = 120000;
  const lease = store.reserveMeeting(companyId, 1000, stale, now);
  expect(() => new CompanyConfigurationStore(db).reserveMeeting(companyId, 1000, stale, now)).toThrow("Limit");
  const agentId = seedAgent(db, companyId);
  const task = new TaskStore(db).create({ companyId, title: "Capacity test", assignedAgentId: agentId });
  const runs = new RunStore(db);
  const run = runs.create({ companyId, taskId: task.id, agentId, runtimeType: "mock", correlationId: "capacity-test" });
  expect(store.admitsTask(companyId, run.id, stale, now)).toBe(false);
  store.releaseMeeting(lease);
  expect(store.admitsTask(companyId, run.id, stale, now)).toBe(true);
  expect(() => store.reserveMeeting(companyId, 1000, stale, now)).toThrow("Limit");
  runs.setStatus(run.id, "completed");
  const next = store.reserveMeeting(companyId, 1000, stale, now);
  expect(next).toBeTruthy();
  expect(store.reserveMeeting(companyId, 1000, stale, now + 11001)).toBeTruthy();
});
