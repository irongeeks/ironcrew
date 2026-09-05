import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { ProjectStore } from "./project-store.ts";
import { TaskStore } from "./task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { UserStore } from "../auth/user-store.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { SandboxAccessService, type SandboxRunScope } from "./sandbox-access-service.ts";
import { resolvePermissionMode } from "../policy/runtime-permissions.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let service: SandboxAccessService;
let orc: CompanyOrchestrator;
let companyId: string;
let taskId: string;
let projectId: string;
let agentId: string;
let ownerId: string;
const input = () => ({
  taskId,
  provider: "codex",
  durationMs: 900_000,
  reason: "Begrenzter Test einer Projektmigration",
});
beforeEach(async () => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  db.prepare(
    "UPDATE crew_vessels SET runtime_provider='codex' WHERE id=(SELECT vessel_id FROM crew_agents WHERE id=?)",
  ).run(agentId);
  projectId = new ProjectStore(db).create({ companyId, title: "Workspace", workspacePath: "/work/sandbox" }).id;
  taskId = new TaskStore(db).create({
    companyId,
    title: "Migration",
    projectId,
    assignedAgentId: agentId,
    status: "ready",
  }).id;
  ownerId = (
    await new UserStore(db).create({ email: "owner@example.invalid", role: "owner", password: "sandbox-test-password" })
  ).id;
  service = new SandboxAccessService(db);
  orc = new CompanyOrchestrator(db);
});
afterEach(() => db.close());
function run(overrides: Partial<SandboxRunScope> = {}): SandboxRunScope {
  const created = new RunStore(db).create({ companyId, taskId, agentId, projectId, runtimeType: "codex" });
  return {
    companyId,
    taskId,
    agentId,
    projectId,
    provider: "codex",
    workspacePath: "/work/sandbox",
    runId: created.id,
    ...overrides,
  };
}
function approve() {
  const approval = service.request(companyId, input(), ownerId);
  orc.reviewApproval(companyId, approval.id, "approved", "Einmalig geprüft", { actorId: ownerId });
  return approval;
}
describe("sandbox access from owner request to one scoped run", () => {
  it("parks the task, requires a real owner decision, then persists and consumes exactly once across restart", () => {
    const approval = service.request(companyId, input(), ownerId);
    expect(orc.tasks.get(taskId)?.status).toBe("approval_required");
    expect(service.settleApproval(companyId, approval.id)).toBeNull();
    expect(service.consumeForRun(run())).toBeNull();
    const outcome = orc.reviewApproval(companyId, approval.id, "approved", "Geprüft", { actorId: ownerId });
    expect(outcome?.decided).toBe(true);
    expect(orc.tasks.get(taskId)?.status).toBe("ready");
    const restarted = new SandboxAccessService(db);
    const scope = run();
    const granted = restarted.consumeForRun(scope)!;
    expect(granted).toMatchObject({ companyId, taskId, workspacePath: "/work/sandbox", approvedBy: ownerId });
    expect(resolvePermissionMode({ ...scope, requested: "elevated", grant: granted }).mode).toBe("elevated");
    expect(restarted.consumeForRun(scope)?.grantId).toBe(granted.grantId);
    expect(new SandboxAccessService(db).consumeForRun(run())).toBeNull();
    expect(db.prepare("SELECT id FROM crew_audit_events WHERE action='sandbox_grant.consumed'").all()).toHaveLength(1);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
  it("requires the full configured quorum and at least one owner vote", async () => {
    const approval = service.request(companyId, input(), ownerId);
    const reviewer = await new UserStore(db).create({
      email: "reviewer@example.invalid",
      role: "operator",
      password: "sandbox-test-password",
    });
    orc.approvalReviews.setRequiredApprovals(approval.id, 2);
    orc.reviewApproval(companyId, approval.id, "approved", "Review", { actorId: reviewer.id });
    expect(service.settleApproval(companyId, approval.id)).toBeNull();
    orc.reviewApproval(companyId, approval.id, "approved", "Owner approval", { actorId: ownerId });
    expect(service.settleApproval(companyId, approval.id)).not.toBeNull();
  });
  it("does not elevate from an operator-only decision even when the numerical quorum is met", async () => {
    const approval = service.request(companyId, input(), ownerId);
    const operator = await new UserStore(db).create({
      email: "only-operator@example.invalid",
      role: "operator",
      password: "sandbox-test-password",
    });
    const outcome = orc.reviewApproval(companyId, approval.id, "approved", "Operator review", { actorId: operator.id });
    expect(outcome?.decided).toBe(true);
    expect(service.settleApproval(companyId, approval.id)).toBeNull();
    expect(service.consumeForRun(run())).toBeNull();
  });
  it("refuses a legacy decision without recorded owner votes and a forged approved object", () => {
    const approval = service.request(companyId, input(), ownerId);
    expect(() =>
      service.grants.mintFromApproval({
        approval: { ...approval, status: "approved" },
        providers: ["codex"],
        requestedDurationMs: 60_000,
      }),
    ).toThrow(/not "approved"/);
    orc.approvals.decide(approval.id, "approved", ownerId);
    expect(service.settleApproval(companyId, approval.id)).toBeNull();
    expect(service.consumeForRun(run())).toBeNull();
  });
  it("refuses bootstrap, operator and arbitrary provider elevation requests", async () => {
    expect(() => service.request(companyId, input(), "ceo")).toThrow(/Owner/);
    const operator = await new UserStore(db).create({
      email: "operator@example.invalid",
      role: "operator",
      password: "sandbox-test-password",
    });
    expect(() => service.request(companyId, input(), operator.id)).toThrow(/Owner/);
    expect(() => service.request(companyId, { ...input(), provider: "openrouter" }, ownerId)).toThrow();
    expect(() => service.request(companyId, { ...input(), provider: "claude" }, ownerId)).toThrow(/Runtime/);
    expect(() => service.request(companyId, { ...input(), durationMs: 86_400_000 }, ownerId)).toThrow();
  });
  it.each(["companyId", "taskId", "agentId", "projectId", "provider", "workspacePath"] as const)(
    "does not consume a grant with mismatching %s",
    (field) => {
      approve();
      const scope = run({ [field]: field === "workspacePath" ? "/work/other" : "other" });
      expect(service.consumeForRun(scope)).toBeNull();
      expect(service.consumeForRun(run())).not.toBeNull();
    },
  );
  it("does not revive expired or revoked grants by reminting an approval", () => {
    const approval = approve();
    const grant = service.settleApproval(companyId, approval.id)!;
    expect(service.revoke("wrong-company", grant.id, ownerId, "no")).toBeNull();
    service.revoke(companyId, grant.id, ownerId, "Stop");
    expect(service.settleApproval(companyId, approval.id)?.id).toBe(grant.id);
    expect(service.consumeForRun(run())).toBeNull();
    db.prepare("UPDATE crew_sandbox_grants SET revoked_at=NULL, expires_at=? WHERE id=?").run(Date.now() - 1, grant.id);
    expect(service.consumeForRun(run())).toBeNull();
  });
  it("does not mint from expired approval or after workspace/agent reassignment", () => {
    const approval = approve();
    db.prepare("UPDATE crew_approvals SET expires_at=? WHERE id=?").run(Date.now() - 1, approval.id);
    expect(service.settleApproval(companyId, approval.id)).toBeNull();
    expect(service.consumeForRun(run())).toBeNull();
    db.prepare("UPDATE crew_approvals SET expires_at=? WHERE id=?").run(Date.now() + 60000, approval.id);
    new ProjectStore(db).update(projectId, { workspacePath: "/work/changed" });
    expect(service.consumeForRun(run())).toBeNull();
  });
  it("fails closed in the permission resolver for another workspace or a future grant", () => {
    approve();
    const scope = run();
    const grant = service.consumeForRun(scope)!;
    expect(resolvePermissionMode({ ...scope, workspacePath: "/work/other", requested: "elevated", grant }).code).toBe(
      "grant_workspace_mismatch",
    );
    expect(
      resolvePermissionMode({ ...scope, requested: "elevated", grant: { ...grant, issuedAt: Date.now() + 60000 } })
        .mode,
    ).toBe("restricted");
  });
});
