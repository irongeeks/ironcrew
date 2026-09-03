import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { verifyAuditChain } from "./audit.ts";
import { SandboxGrantMintError, SandboxGrantStore } from "./sandbox-grant-store.ts";
import { ApprovalEngine, type ApprovalRow } from "../policy/approval-policy.ts";
import { MAX_SANDBOX_GRANT_MS } from "../policy/runtime-permissions.ts";
import { TaskStore } from "./task-store.ts";

let db: DatabaseSync;
let store: SandboxGrantStore;
let approvals: ApprovalEngine;
let tasks: TaskStore;
let companyId: string;
let taskId: string;

beforeEach(() => {
  db = createTestDb();
  store = new SandboxGrantStore(db);
  approvals = new ApprovalEngine(db);
  tasks = new TaskStore(db);
  companyId = seedCompany(db);
  taskId = tasks.create({ companyId, title: "one-off migration script", status: "ready" }).id;
});

afterEach(() => db.close());

function approvedSandboxElevation(overrides: Partial<{ decidedBy: string }> = {}): ApprovalRow {
  const a = approvals.request(
    companyId,
    { approvalType: "sandbox_elevation", requestedBy: "agt_cto", summary: "one-off migration script" },
    { taskId },
  );
  approvals.decide(a.id, "approved", overrides.decidedBy ?? "owner-1", "reviewed, time-boxed");
  return approvals.get(a.id)!;
}

describe("mintFromApproval — the only path to a grant", () => {
  it("mints a grant from a genuinely approved sandbox_elevation approval", () => {
    const approval = approvedSandboxElevation();
    const grant = store.mintFromApproval({
      approval,
      providers: ["claude"],
      requestedDurationMs: 60 * 60_000,
      taskId,
    });
    expect(grant.company_id).toBe(companyId);
    expect(grant.approval_id).toBe(approval.id);
    expect(JSON.parse(grant.providers_json)).toEqual(["claude"]);
    expect(grant.revoked_at).toBeNull();
  });

  it("refuses an approval of any other type", () => {
    const a = approvals.request(companyId, {
      approvalType: "bank_transfer",
      requestedBy: "agt_finance",
      summary: "pay invoice",
    });
    approvals.decide(a.id, "approved", "owner-1");
    const approval = approvals.get(a.id)!;
    expect(() => store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 })).toThrow(
      SandboxGrantMintError,
    );
  });

  it("refuses a pending approval", () => {
    const a = approvals.request(companyId, {
      approvalType: "sandbox_elevation",
      requestedBy: "agt_cto",
      summary: "wants elevation",
    });
    expect(() => store.mintFromApproval({ approval: a, providers: ["claude"], requestedDurationMs: 60_000 })).toThrow(
      /not "approved"/,
    );
  });

  it("refuses a rejected approval", () => {
    const a = approvals.request(companyId, {
      approvalType: "sandbox_elevation",
      requestedBy: "agt_cto",
      summary: "wants elevation",
    });
    approvals.decide(a.id, "rejected", "owner-1", "not justified");
    const approval = approvals.get(a.id)!;
    expect(() => store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 })).toThrow(
      SandboxGrantMintError,
    );
  });

  it("refuses an expired approval", () => {
    const a = approvals.request(companyId, {
      approvalType: "sandbox_elevation",
      requestedBy: "agt_cto",
      summary: "x",
      expiresAt: Date.now() - 1000,
    });
    approvals.listPending(companyId); // triggers the expiry sweep, matching ApprovalEngine's own contract
    const approval = approvals.get(a.id)!;
    expect(approval.status).toBe("expired");
    expect(() => store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 })).toThrow(
      SandboxGrantMintError,
    );
  });

  it("refuses an empty provider list", () => {
    const approval = approvedSandboxElevation();
    expect(() => store.mintFromApproval({ approval, providers: [], requestedDurationMs: 60_000 })).toThrow(
      /at least one/,
    );
  });

  it("clamps an over-long request to the policy maximum", () => {
    const approval = approvedSandboxElevation();
    const now = Date.now();
    const grant = store.mintFromApproval({
      approval,
      providers: ["claude"],
      requestedDurationMs: 365 * 24 * 3600_000,
      now,
    });
    expect(grant.expires_at).toBe(now + MAX_SANDBOX_GRANT_MS);
  });

  it("audits the mint", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    const rows = db.prepare("SELECT action FROM ic_audit_events WHERE action='sandbox_grant.minted'").all();
    expect(rows).toHaveLength(1);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("carries the approval's decider as approvedBy", () => {
    const approval = approvedSandboxElevation({ decidedBy: "owner-42" });
    const grant = store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    expect(grant.approved_by).toBe("owner-42");
  });
});

describe("findLive", () => {
  it("finds a live grant scoped to its task and provider", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({
      approval,
      providers: ["claude"],
      requestedDurationMs: 60_000,
      taskId,
    });
    const found = store.findLive({ companyId, provider: "claude", taskId });
    expect(found).not.toBeNull();
    expect(found!.approvalId).toBe(approval.id);
  });

  it("is case-insensitive on the provider name", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({ approval, providers: ["Claude"], requestedDurationMs: 60_000 });
    expect(store.findLive({ companyId, provider: "claude" })).not.toBeNull();
  });

  it("does not match a different provider", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    expect(store.findLive({ companyId, provider: "codex" })).toBeNull();
  });

  it("does not match a different task when the grant is task-scoped", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({
      approval,
      providers: ["claude"],
      requestedDurationMs: 60_000,
      taskId,
    });
    const otherTaskId = tasks.create({ companyId, title: "other", status: "ready" }).id;
    expect(store.findLive({ companyId, provider: "claude", taskId: otherTaskId })).toBeNull();
  });

  it("a company-wide grant (no task scope) matches any task", () => {
    const approval = approvedSandboxElevation();
    store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    expect(store.findLive({ companyId, provider: "claude", taskId })).not.toBeNull();
  });

  it("does not find an expired grant", () => {
    const approval = approvedSandboxElevation();
    const now = Date.now();
    store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 1000, now });
    expect(store.findLive({ companyId, provider: "claude", now: now + 2000 })).toBeNull();
  });

  it("does not find a revoked grant even if still time-valid", () => {
    const approval = approvedSandboxElevation();
    const grant = store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    store.revoke(grant.id, "owner-1", "no longer needed");
    expect(store.findLive({ companyId, provider: "claude" })).toBeNull();
  });

  it("is scoped to the company", () => {
    const otherCompany = seedCompany(db, "Other Co");
    const approval = approvedSandboxElevation();
    store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    expect(store.findLive({ companyId: otherCompany, provider: "claude" })).toBeNull();
  });

  it("prefers the most recently issued matching grant", () => {
    const a1 = approvedSandboxElevation();
    const older = store.mintFromApproval({
      approval: a1,
      providers: ["claude"],
      requestedDurationMs: 60_000,
      now: 1000,
    });
    const a2 = approvedSandboxElevation();
    const newer = store.mintFromApproval({
      approval: a2,
      providers: ["claude"],
      requestedDurationMs: 60_000,
      now: 2000,
    });
    const found = store.findLive({ companyId, provider: "claude", now: 2500 });
    expect(found!.grantId).toBe(newer.id);
    expect(found!.grantId).not.toBe(older.id);
  });
});

describe("revoke", () => {
  it("is idempotent", () => {
    const approval = approvedSandboxElevation();
    const grant = store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    const first = store.revoke(grant.id, "owner-1");
    const second = store.revoke(grant.id, "owner-1");
    expect(first!.revoked_at).toBe(second!.revoked_at);
  });

  it("returns null for an unknown grant", () => {
    expect(store.revoke("grant_nope", "owner-1")).toBeNull();
  });

  it("audits the revocation", () => {
    const approval = approvedSandboxElevation();
    const grant = store.mintFromApproval({ approval, providers: ["claude"], requestedDurationMs: 60_000 });
    store.revoke(grant.id, "owner-1", "no longer needed");
    const rows = db.prepare("SELECT action FROM ic_audit_events WHERE action='sandbox_grant.revoked'").all();
    expect(rows).toHaveLength(1);
  });
});

describe("listActive", () => {
  it("lists only unrevoked, unexpired grants for the company", () => {
    const now = Date.now();
    const a1 = approvedSandboxElevation();
    const live = store.mintFromApproval({ approval: a1, providers: ["claude"], requestedDurationMs: 60_000, now });
    const a2 = approvedSandboxElevation();
    const expired = store.mintFromApproval({ approval: a2, providers: ["codex"], requestedDurationMs: 10, now });
    const a3 = approvedSandboxElevation();
    const revoked = store.mintFromApproval({ approval: a3, providers: ["gemini"], requestedDurationMs: 60_000, now });
    store.revoke(revoked.id, "owner-1");

    const active = store.listActive(companyId, now + 1000);
    expect(active.map((g) => g.id)).toEqual([live.id]);
    expect(active.some((g) => g.id === expired.id)).toBe(false);
    expect(active.some((g) => g.id === revoked.id)).toBe(false);
  });
});
