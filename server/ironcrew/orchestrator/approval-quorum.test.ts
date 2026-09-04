/**
 * Four eyes, end to end.
 *
 * `approval-review-store.test.ts` proves the tally is counted correctly. This
 * file proves the *system* obeys it: that a task parked behind a two-person
 * approval stays parked after one yes, moves after the second, and dies on
 * the first no whatever the count already stood at.
 *
 * The distinction matters because the two halves fail differently. A wrong
 * tally is a visible bug. A correct tally that nothing consults is invisible:
 * the UI shows "1 von 2" and the money moves anyway.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { listAuditEvents, verifyAuditChain } from "../domain/audit.ts";
import { ApprovalReviewError } from "../domain/approval-review-store.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

const SENSITIVE = "Bitte überweise 100 EUR an den Lieferanten.";

// Two real people. The point of the whole feature is that these are different
// strings in the audit chain, so the test uses ids shaped like the ones the
// identity layer mints (docs/IDENTITY.md).
const ANNA = { actorId: "usr_anna" };
const BOB = { actorId: "usr_bob" };

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Erledigt." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => db.close());

function parked(required?: number) {
  const result = orc.handleCeoMessage(companyId, SENSITIVE);
  const approval = orc.approvals.listPending(companyId)[0]!;
  expect(result.task!.status).toBe("approval_required");
  if (required !== undefined) orc.approvalReviews.setRequiredApprovals(approval.id, required);
  return { task: result.task!, approval };
}

describe("the default quorum of one changes nothing", () => {
  it("settles on the first yes, exactly as before quorums existed", () => {
    const { task, approval } = parked();

    const outcome = orc.reviewApproval(companyId, approval.id, "approved", "geprüft", ANNA)!;

    expect(outcome.decided).toBe(true);
    expect(outcome.tally.required).toBe(1);
    expect(outcome.approval.status).toBe("approved");
    // The task actually moves — the failure this system had before #60.
    expect(orc.tasks.get(task.id)!.status).toBe("ready");
  });

  it("still returns null for an approval that is not pending, or not ours", () => {
    const { approval } = parked();
    expect(orc.reviewApproval(companyId, "apr_nope", "approved", "", ANNA)).toBeNull();
    orc.reviewApproval(companyId, approval.id, "approved", "", ANNA);
    expect(orc.reviewApproval(companyId, approval.id, "approved", "", BOB)).toBeNull();
  });
});

describe("a quorum of two needs two people", () => {
  it("holds the task after one yes and releases it after the second", () => {
    const { task, approval } = parked(2);

    const first = orc.reviewApproval(companyId, approval.id, "approved", "sieht gut aus", ANNA)!;
    expect(first.decided).toBe(false);
    expect(first.tally).toMatchObject({ approvals: 1, required: 2, outstanding: 1, satisfied: false });
    // The whole point: the approval is still pending and the money has not
    // moved. A "decided: false" that let the task run would be the bug.
    expect(orc.approvals.get(approval.id)!.status).toBe("pending");
    expect(orc.tasks.get(task.id)!.status).toBe("approval_required");

    const second = orc.reviewApproval(companyId, approval.id, "approved", "IBAN geprüft", BOB)!;
    expect(second.decided).toBe(true);
    expect(second.tally).toMatchObject({ approvals: 2, required: 2, outstanding: 0, satisfied: true });
    expect(orc.tasks.get(task.id)!.status).toBe("ready");
  });

  it("cannot be satisfied by one person clicking twice", () => {
    const { task, approval } = parked(2);

    orc.reviewApproval(companyId, approval.id, "approved", "", ANNA);
    // A refreshed tab, a double submit, an impatient owner. The UNIQUE index
    // decides; the store turns it into a sentence.
    expect(() => orc.reviewApproval(companyId, approval.id, "approved", "", ANNA)).toThrow(ApprovalReviewError);

    expect(orc.approvals.get(approval.id)!.status).toBe("pending");
    expect(orc.tasks.get(task.id)!.status).toBe("approval_required");
  });

  it("names both reviewers in the audit chain, not a shared constant", () => {
    const { approval } = parked(2);
    orc.reviewApproval(companyId, approval.id, "approved", "", ANNA);
    orc.reviewApproval(companyId, approval.id, "approved", "", BOB);

    const reviewed = listAuditEvents(db, companyId, { limit: 200 }).filter((e) =>
      String(e.action).startsWith("approval.review_"),
    );
    expect(reviewed.map((e) => e.actor_id).sort()).toEqual(["usr_anna", "usr_bob"]);
    // Humans stay "owner" in the actor_type column whatever their role; only
    // actor_id individuates them (T-19).
    expect(new Set(reviewed.map((e) => e.actor_type))).toEqual(new Set(["owner"]));
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("one rejection is decisive", () => {
  it("stops a change that already had an approval", () => {
    const { task, approval } = parked(2);

    orc.reviewApproval(companyId, approval.id, "approved", "sieht gut aus", ANNA);
    const no = orc.reviewApproval(companyId, approval.id, "rejected", "IBAN stimmt nicht", BOB)!;

    // The asymmetry from migration 0023: a reviewer who has spotted the wrong
    // IBAN must not need a colleague's agreement to stop the payment.
    expect(no.decided).toBe(true);
    expect(no.tally).toMatchObject({ approvals: 1, rejections: 1, blocked: true, satisfied: false });
    expect(orc.approvals.get(approval.id)!.status).toBe("rejected");
    expect(orc.tasks.get(task.id)!.status).toBe("cancelled");
    expect(orc.tasks.get(task.id)!.status_reason).toContain("IBAN stimmt nicht");
  });

  it("does not need a quorum of its own", () => {
    const { task, approval } = parked(3);
    const no = orc.reviewApproval(companyId, approval.id, "rejected", "nein", ANNA)!;
    expect(no.decided).toBe(true);
    expect(no.tally.outstanding).toBe(0);
    expect(orc.tasks.get(task.id)!.status).toBe("cancelled");
  });
});

describe("the quorum is a property of the approval", () => {
  it("refuses a quorum nobody could satisfy, and one of zero", () => {
    const { approval } = parked();
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 0)).toThrow(ApprovalReviewError);
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 50)).toThrow(ApprovalReviewError);
    expect(orc.approvalReviews.tally(approval.id).required).toBe(1);
  });

  it("cannot be changed after the decision — that would rewrite what was required", () => {
    const { approval } = parked();
    orc.reviewApproval(companyId, approval.id, "approved", "", ANNA);
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 2)).toThrow(ApprovalReviewError);
  });

  it("records raising it, so the audit chain shows the gate was tightened", () => {
    const { approval } = parked();
    orc.approvalReviews.setRequiredApprovals(approval.id, 2, { actorId: "usr_anna" });
    const set = listAuditEvents(db, companyId, { limit: 200 }).find((e) => e.action === "approval.quorum_set")!;
    expect(set.actor_id).toBe("usr_anna");
    expect(JSON.parse(String(set.details_json))).toMatchObject({ from: 1, to: 2 });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
