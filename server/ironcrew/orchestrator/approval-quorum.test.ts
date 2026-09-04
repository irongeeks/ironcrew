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
import fs from "node:fs";
import os from "node:os";

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

/** A real directory, so an applied proposal has somewhere to write. */
let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-quorum-"));
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime({ responseText: "Erledigt." }));
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
});

afterEach(() => {
  db.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

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

describe("the ways a quorum was found to be bypassable", () => {
  /**
   * Both of these were live. A security review over this branch demonstrated
   * each end to end against a real Express stack with two owner sessions, and
   * these are the regressions for them. Neither is hypothetical, and neither
   * is a corner case: the first is the exact scenario T-21 was written for.
   */

  it("cannot be undone by lowering it — that would cost an attacker one request", () => {
    const { approval } = parked(2);

    // T-21's threat is one compromised owner account deciding everything, and
    // the per-approval quorum is its stated mitigation. If the same account
    // could send { required: 1 } and then approve, the mitigation would be
    // decoration: the audit chain records the change, which is detection, not
    // prevention.
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 1)).toThrow(ApprovalReviewError);
    expect(orc.approvalReviews.tally(approval.id).required).toBe(2);

    // And the gate still holds afterwards.
    const first = orc.reviewApproval(companyId, approval.id, "approved", "", ANNA)!;
    expect(first.decided).toBe(false);
    expect(orc.approvals.get(approval.id)!.status).toBe("pending");
  });

  it("cannot be changed at all once somebody has voted", () => {
    const { approval } = parked(2);
    orc.reviewApproval(companyId, approval.id, "approved", "", ANNA);
    // Raising it mid-vote moves the goalposts under the people already
    // counted; lowering it is refused anyway.
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 3)).toThrow(/bereits/);
    expect(orc.approvalReviews.tally(approval.id).required).toBe(2);
  });

  it("treats a repeated demand for the same quorum as the same demand", () => {
    const { approval } = parked();
    orc.approvalReviews.setRequiredApprovals(approval.id, 2);
    // A double-clicked button is one request twice, not a second demand.
    // Refusing it would put an error in front of somebody who got what they
    // asked for.
    expect(() => orc.approvalReviews.setRequiredApprovals(approval.id, 2)).not.toThrow();
    expect(orc.approvalReviews.tally(approval.id).required).toBe(2);
  });

  it("still governs a file-change proposal, which used to go around it", () => {
    // `decideChangeProposal` called `approvals.decide()` directly, so an
    // owner could demand four eyes on a deploy script, watch the panel
    // confirm "0 von 2", approve alone and write the files. A gate with a
    // bypass is not a gate (T-15).
    const { proposal, approvalId } = orc.proposeChanges(companyId, {
      title: "Deploy-Skript ändern",
      workspacePath: workspace,
      files: [{ path: "deploy.sh", operation: "create", content: "#!/bin/sh\necho neu\n" }],
    });
    orc.approvalReviews.setRequiredApprovals(approvalId, 2);

    const alone = orc.decideChangeProposal(companyId, proposal.id, "approved", { reason: "sieht gut aus", ...ANNA })!;
    expect(alone.decided).toBe(false);
    expect(alone.tally).toMatchObject({ approvals: 1, required: 2, outstanding: 1 });
    expect(orc.changeProposals.get(proposal.id)!.status).toBe("pending");
    expect(orc.approvals.get(approvalId)!.status).toBe("pending");
    // And the write is still refused, which is T-15's second line of defence.
    expect(() => orc.applyChangeProposal(companyId, proposal.id, ANNA)).toThrow(/pending|nichts/i);

    const second = orc.decideChangeProposal(companyId, proposal.id, "approved", { reason: "geprüft", ...BOB })!;
    expect(second.decided).toBe(true);
    expect(orc.changeProposals.get(proposal.id)!.status).toBe("approved");
    expect(orc.approvals.get(approvalId)!.status).toBe("approved");
  });

  it("lets one reviewer stop a file change, whatever the count stood at", () => {
    const { proposal, approvalId } = orc.proposeChanges(companyId, {
      title: "Deploy-Skript ändern",
      workspacePath: workspace,
      files: [{ path: "deploy.sh", operation: "create", content: "#!/bin/sh\necho neu\n" }],
    });
    orc.approvalReviews.setRequiredApprovals(approvalId, 2);

    orc.decideChangeProposal(companyId, proposal.id, "approved", { ...ANNA });
    const no = orc.decideChangeProposal(companyId, proposal.id, "rejected", { reason: "löscht Prod", ...BOB })!;

    expect(no.decided).toBe(true);
    expect(orc.changeProposals.get(proposal.id)!.status).toBe("rejected");
    expect(() => orc.applyChangeProposal(companyId, proposal.id, ANNA)).toThrow();
  });

  it("records each reviewer of a file change individually", () => {
    const { proposal, approvalId } = orc.proposeChanges(companyId, {
      title: "Deploy-Skript ändern",
      workspacePath: workspace,
      files: [{ path: "deploy.sh", operation: "create", content: "x" }],
    });
    orc.approvalReviews.setRequiredApprovals(approvalId, 2);
    orc.decideChangeProposal(companyId, proposal.id, "approved", { ...ANNA });
    orc.decideChangeProposal(companyId, proposal.id, "approved", { ...BOB });

    expect(
      orc.approvalReviews
        .listFor(approvalId)
        .map((r) => r.reviewer_id)
        .sort(),
    ).toEqual(["usr_anna", "usr_bob"]);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});
