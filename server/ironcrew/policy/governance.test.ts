import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "../domain/test-db.ts";
import { TaskStore } from "../domain/task-store.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import {
  ALWAYS_APPROVAL_REQUIRED,
  ApprovalEngine,
  ApprovalRequiredError,
  requiresApproval,
} from "./approval-policy.ts";
import { BudgetEngine, BudgetExceededError, dayKey, monthKey, stateFor } from "./budget-engine.ts";

let db: DatabaseSync;
let companyId: string;
let agentId: string;
let taskId: string;
let approvals: ApprovalEngine;
let budgets: BudgetEngine;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  taskId = new TaskStore(db).create({ companyId, title: "t", status: "ready" }).id;
  approvals = new ApprovalEngine(db);
  budgets = new BudgetEngine(db);
});

afterEach(() => db.close());

// --------------------------------------------------------------------------

describe("approval policy surface", () => {
  it("marks every non-negotiable action as approval-required", () => {
    for (const t of ALWAYS_APPROVAL_REQUIRED) expect(requiresApproval(t)).toBe(true);
  });

  it("covers the actions the company policy names explicitly", () => {
    for (const t of [
      "bank_transfer",
      "tax_filing",
      "contract_execution",
      "production_deployment",
      "tier0_change",
      "irreversible_data_change",
      "secret_disclosure",
      "permission_change",
      "agent_lifecycle_change",
    ]) {
      expect(ALWAYS_APPROVAL_REQUIRED).toContain(t);
    }
  });

  it("leaves ordinary actions unrestricted", () => {
    expect(requiresApproval("read_file")).toBe(false);
    expect(requiresApproval("draft_document")).toBe(false);
  });
});

describe("approval enforcement", () => {
  it("blocks a high-risk action when no approval exists", () => {
    expect(() => approvals.assertActionPermitted(companyId, "bank_transfer", taskId)).toThrow(ApprovalRequiredError);
  });

  it("still blocks while the approval is only pending", () => {
    approvals.request(
      companyId,
      {
        approvalType: "bank_transfer",
        requestedBy: agentId,
        summary: "pay invoice 42",
      },
      { taskId },
    );
    expect(() => approvals.assertActionPermitted(companyId, "bank_transfer", taskId)).toThrow(ApprovalRequiredError);
  });

  it("permits the action once the owner approves", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "bank_transfer",
        requestedBy: agentId,
        summary: "pay invoice 42",
      },
      { taskId },
    );
    approvals.decide(a.id, "approved", "owner-1", "verified against the invoice");
    expect(() => approvals.assertActionPermitted(companyId, "bank_transfer", taskId)).not.toThrow();
  });

  it("keeps blocking after a rejection", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "tax_filing",
        requestedBy: agentId,
        summary: "submit UStVA",
      },
      { taskId },
    );
    approvals.decide(a.id, "rejected", "owner-1", "figures not reconciled");
    expect(() => approvals.assertActionPermitted(companyId, "tax_filing", taskId)).toThrow(ApprovalRequiredError);
  });

  it("does not let an approval for one task authorise another", () => {
    const other = new TaskStore(db).create({ companyId, title: "other", status: "ready" }).id;
    const a = approvals.request(
      companyId,
      {
        approvalType: "production_deployment",
        requestedBy: agentId,
        summary: "deploy",
      },
      { taskId },
    );
    approvals.decide(a.id, "approved", "owner-1");
    expect(() => approvals.assertActionPermitted(companyId, "production_deployment", other)).toThrow(
      ApprovalRequiredError,
    );
  });

  it("does not let an approval for one action type authorise another", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "production_deployment",
        requestedBy: agentId,
        summary: "deploy",
      },
      { taskId },
    );
    approvals.decide(a.id, "approved", "owner-1");
    expect(() => approvals.assertActionPermitted(companyId, "bank_transfer", taskId)).toThrow(ApprovalRequiredError);
  });

  it("expires an overdue approval and resumes blocking", () => {
    const past = Date.now() - 1000;
    const a = approvals.request(
      companyId,
      {
        approvalType: "tier0_change",
        requestedBy: agentId,
        summary: "dc change",
        expiresAt: past,
      },
      { taskId },
    );
    expect(approvals.listPending(companyId)).toHaveLength(0);
    expect(approvals.get(a.id)!.status).toBe("expired");
    expect(() => approvals.assertActionPermitted(companyId, "tier0_change", taskId)).toThrow();
  });

  it("stops honouring an approved decision once it has expired", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "secret_disclosure",
        requestedBy: agentId,
        summary: "reveal ref",
        expiresAt: Date.now() + 10_000,
      },
      { taskId },
    );
    approvals.decide(a.id, "approved", "owner-1");
    expect(approvals.isApproved(companyId, "secret_disclosure", taskId)).toBe(true);
    expect(approvals.isApproved(companyId, "secret_disclosure", taskId, Date.now() + 20_000)).toBe(false);
  });

  it("resolves a double decision to a single winner", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "contract_execution",
        requestedBy: agentId,
        summary: "sign",
      },
      { taskId },
    );
    expect(approvals.decide(a.id, "approved", "owner-1")).not.toBeNull();
    expect(approvals.decide(a.id, "rejected", "owner-2")).toBeNull();
    expect(approvals.get(a.id)!.status).toBe("approved");
  });

  it("audits request, decision and each block", () => {
    const a = approvals.request(
      companyId,
      {
        approvalType: "bank_transfer",
        requestedBy: agentId,
        summary: "pay",
      },
      { taskId },
    );
    try {
      approvals.assertActionPermitted(companyId, "bank_transfer", taskId);
    } catch {
      /* expected */
    }
    approvals.decide(a.id, "approved", "owner-1");

    const actions = (
      db.prepare("SELECT action FROM crew_audit_events ORDER BY seq").all() as Array<{ action: string }>
    ).map((r) => r.action);
    expect(actions).toContain("approval.requested");
    expect(actions).toContain("approval.blocked");
    expect(actions).toContain("approval.approved");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("lists pending approvals for the decision inbox", () => {
    approvals.request(companyId, { approvalType: "bank_transfer", requestedBy: agentId, summary: "a" }, { taskId });
    approvals.request(companyId, { approvalType: "tax_filing", requestedBy: agentId, summary: "b" }, { taskId });
    expect(approvals.listPending(companyId)).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------

describe("budget maths", () => {
  it("classifies states around the thresholds", () => {
    expect(stateFor(0, 1000, 80)).toBe("ok");
    expect(stateFor(799, 1000, 80)).toBe("ok");
    expect(stateFor(800, 1000, 80)).toBe("warning");
    expect(stateFor(999, 1000, 80)).toBe("warning");
    expect(stateFor(1000, 1000, 80)).toBe("hard_stop");
    expect(stateFor(5000, 1000, 80)).toBe("hard_stop");
  });

  it("treats a zero limit as unlimited rather than instantly exceeded", () => {
    expect(stateFor(10_000, 0, 80)).toBe("ok");
  });

  it("derives UTC window keys", () => {
    const ts = Date.parse("2026-03-09T23:30:00Z");
    expect(monthKey(ts)).toBe("2026-03");
    expect(dayKey(ts)).toBe("2026-03-09");
  });
});

describe("budget enforcement", () => {
  it("permits a run while under the limit", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 10_000_000 });
    budgets.recordCost({ companyId, agentId, taskId, costMicros: 1_000_000 });
    expect(() => budgets.assertRunPermitted(companyId, { agentId, taskId })).not.toThrow();
  });

  it("stops runs once the company hard limit is reached", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000_000 });
    budgets.recordCost({ companyId, agentId, taskId, costMicros: 1_000_000 });
    expect(() => budgets.assertRunPermitted(companyId, { agentId, taskId })).toThrow(BudgetExceededError);
  });

  it("enforces a per-agent budget without touching other agents", () => {
    const other = seedAgent(db, companyId, "other");
    budgets.setBudget({ companyId, scopeType: "agent", scopeId: agentId, limitMicros: 500_000 });
    budgets.recordCost({ companyId, agentId, taskId, costMicros: 500_000 });
    expect(() => budgets.assertRunPermitted(companyId, { agentId })).toThrow(BudgetExceededError);
    expect(() => budgets.assertRunPermitted(companyId, { agentId: other })).not.toThrow();
  });

  it("reports a warning before stopping", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000_000, warnPercent: 80 });
    const { breached } = budgets.recordCost({ companyId, agentId, costMicros: 850_000 });
    expect(breached).toHaveLength(1);
    expect(breached[0].state).toBe("warning");
    expect(() => budgets.assertRunPermitted(companyId, { agentId })).not.toThrow();
  });

  it("honours hard_stop=false as warn-only", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000, hardStop: false });
    budgets.recordCost({ companyId, agentId, costMicros: 50_000 });
    expect(() => budgets.assertRunPermitted(companyId, { agentId })).not.toThrow();
  });

  it("does not count subscription quota events as money", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000_000 });
    budgets.recordCost({
      companyId,
      agentId,
      kind: "quota",
      runtimeType: "claude-code",
      inputTokens: 500_000,
      outputTokens: 100_000,
      costMicros: 999_999_999,
    });
    const [status] = budgets.status(companyId, { agentId });
    expect(status.spentMicros).toBe(0);
    expect(() => budgets.assertRunPermitted(companyId, { agentId })).not.toThrow();
  });

  it("still records token consumption for a quota event", () => {
    budgets.recordCost({
      companyId,
      agentId,
      kind: "quota",
      runtimeType: "claude-code",
      inputTokens: 1234,
      outputTokens: 56,
    });
    const row = db.prepare("SELECT input_tokens, output_tokens FROM crew_cost_events").get() as {
      input_tokens: number;
      output_tokens: number;
    };
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(56);
  });

  it("scopes monthly budgets to their window", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000_000, windowKind: "calendar_month_utc" });
    const march = Date.parse("2026-03-15T00:00:00Z");
    const april = Date.parse("2026-04-15T00:00:00Z");
    budgets.recordCost({ companyId, agentId, costMicros: 1_000_000, now: march });
    expect(() => budgets.assertRunPermitted(companyId, { agentId }, march)).toThrow(BudgetExceededError);
    // A new month starts from zero.
    expect(() => budgets.assertRunPermitted(companyId, { agentId }, april)).not.toThrow();
  });

  it("applies the strictest covering budget", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 10_000_000 });
    budgets.setBudget({ companyId, scopeType: "agent", scopeId: agentId, limitMicros: 100_000 });
    budgets.recordCost({ companyId, agentId, costMicros: 150_000 });
    expect(() => budgets.assertRunPermitted(companyId, { agentId })).toThrow(BudgetExceededError);
  });

  it("updates an existing budget rather than duplicating it", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000 });
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 2_000 });
    const rows = db.prepare("SELECT * FROM crew_budgets WHERE company_id = ?").all(companyId);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { limit_micros: number }).limit_micros).toBe(2_000);
  });

  it("audits a blocked run and keeps the chain valid", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000 });
    budgets.recordCost({ companyId, agentId, costMicros: 5_000 });
    try {
      budgets.assertRunPermitted(companyId, { agentId });
    } catch {
      /* expected */
    }
    const actions = (db.prepare("SELECT action FROM crew_audit_events").all() as Array<{ action: string }>).map(
      (r) => r.action,
    );
    expect(actions).toContain("budget.hard_stop_reached");
    expect(actions).toContain("budget.run_blocked");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("accumulates spend without floating point drift", () => {
    budgets.setBudget({ companyId, scopeType: "company", limitMicros: 1_000_000 });
    for (let i = 0; i < 1000; i++) budgets.recordCost({ companyId, agentId, costMicros: 999 });
    expect(budgets.status(companyId, { agentId })[0].spentMicros).toBe(999_000);
  });
});
