import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedCompany } from "./test-db.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import { ApprovalReviewError, ApprovalReviewStore } from "./approval-review-store.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { migration as crewApprovalReviews } from "../../modules/bootstrap/migrations/0023-crew-approval-reviews.ts";

let db: DatabaseSync;
let store: ApprovalReviewStore;
let approvals: ApprovalEngine;
let companyId: string;

/**
 * Migration 0023 is not in `test-db.ts` yet, so this suite applies it itself
 * onto the real schema — and asserts first that the table it extends is
 * actually there, so a wiring mistake fails as a wiring mistake rather than as
 * a puzzling constraint error later.
 */
beforeEach(() => {
  db = createTestDb();
  const approvalsTable = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='crew_approvals'")
    .get() as { n: number };
  expect(approvalsTable.n).toBe(1);

  crewApprovalReviews.up(db);

  store = new ApprovalReviewStore(db);
  approvals = new ApprovalEngine(db);
  companyId = seedCompany(db);
});

afterEach(() => db.close());

/** A dangerous request, raised by an agent as the real ones are. */
function raise(requiredApprovals = 1): string {
  const approval = approvals.request(companyId, {
    approvalType: "bank_transfer",
    requestedBy: "agt_finance",
    summary: "Zahlung an Lieferant, 42.000 EUR",
    riskLevel: "critical",
  });
  if (requiredApprovals !== 1) store.setRequiredApprovals(approval.id, requiredApprovals, { actorId: "usr_anna" });
  return approval.id;
}

describe("the migration", () => {
  it("gives every existing approval a quorum of one, so nothing changes for routine work", () => {
    const id = raise();
    const row = db.prepare("SELECT required_approvals FROM crew_approvals WHERE id = ?").get(id) as {
      required_approvals: number;
    };
    expect(row.required_approvals).toBe(1);
  });

  it("is idempotent — re-applying it neither duplicates the column nor drops the reviews", () => {
    const id = raise();
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });
    crewApprovalReviews.up(db);
    expect(store.listFor(id)).toHaveLength(1);
  });
});

describe("a quorum of one", () => {
  it("is satisfied by a single reviewer", () => {
    const id = raise();
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved", reason: "IBAN geprüft" });

    const tally = store.tally(id);
    expect(tally).toMatchObject({
      approvals: 1,
      rejections: 0,
      required: 1,
      satisfied: true,
      blocked: false,
      outstanding: 0,
    });
  });

  it("reports a self-approval rather than hiding it", () => {
    const id = raise();
    // The requester here is the agent, so an owner's review is not a
    // self-approval; the flag exists for the case where a person raises their
    // own request, which a quorum of one cannot structurally prevent.
    store.record({ approvalId: id, reviewerId: "agt_finance", verdict: "approved" });
    expect(store.tally(id).selfApproved).toBe(true);
  });
});

describe("a quorum of two", () => {
  it("is not satisfied by one voice, and outstanding says how many are missing", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved", reason: "geprüft" });

    const tally = store.tally(id);
    expect(tally.approvals).toBe(1);
    expect(tally.required).toBe(2);
    expect(tally.satisfied).toBe(false);
    expect(tally.blocked).toBe(false);
    expect(tally.outstanding).toBe(1);
  });

  it("is satisfied once a second, different person agrees", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "approved" });

    expect(store.tally(id)).toMatchObject({ approvals: 2, satisfied: true, outstanding: 0 });
  });

  it("refuses a second vote from the same person — a second click is not a second reviewer", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });

    expect(() => store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" })).toThrow(
      ApprovalReviewError,
    );
    expect(() => store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" })).toThrow(
      /bereits bewertet/,
    );

    // And the refusal is real: the quorum still is not met.
    expect(store.tally(id)).toMatchObject({ approvals: 1, satisfied: false, outstanding: 1 });
  });
});

describe("a rejection is decisive", () => {
  it("blocks even when the required number of approvals is already there", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "approved" });
    expect(store.tally(id).satisfied).toBe(true);

    store.record({
      approvalId: id,
      reviewerId: "usr_chris",
      verdict: "rejected",
      reason: "IBAN gehört nicht dem Lieferanten",
    });

    const tally = store.tally(id);
    expect(tally.approvals).toBe(2);
    expect(tally.rejections).toBe(1);
    expect(tally.blocked).toBe(true);
    expect(tally.satisfied).toBe(false);
    // Nothing is outstanding: no further approval can revive it.
    expect(tally.outstanding).toBe(0);
  });

  it("needs no quorum of its own — one person stops a change three others wanted", () => {
    const id = raise(3);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "rejected", reason: "Betrag stimmt nicht" });

    expect(store.tally(id)).toMatchObject({ approvals: 0, rejections: 1, blocked: true, satisfied: false });
  });

  it("still blocks when it arrives after the quorum was already satisfied — the tally is never latched", () => {
    const id = raise(1);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });
    expect(store.tally(id).satisfied).toBe(true);

    // The approval row is still pending: a satisfied quorum is evidence, not a
    // decision, and until someone acts on it a late "no" is still in time.
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "rejected", reason: "zu spät gesehen" });

    expect(store.tally(id)).toMatchObject({ satisfied: false, blocked: true, outstanding: 0 });
  });
});

describe("the audit trail", () => {
  it("names each reviewer individually", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved", reason: "IBAN geprüft" });
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "approved", reason: "Vertrag gesehen" });

    const events = listAuditEvents(db, companyId, { limit: 50 }) as Array<Record<string, string>>;
    const reviewEvents = events.filter((e) => e.action === "approval.review_approved");
    expect(reviewEvents.map((e) => e.actor_id).sort()).toEqual(["usr_anna", "usr_bob"]);
    for (const event of reviewEvents) {
      expect(event.approval_id).toBe(id);
      expect(event.actor_type).toBe("owner");
    }

    // The moment the gate could open is an entry of its own, not something a
    // later reader has to reconstruct by counting.
    const reached = events.find((e) => e.action === "approval.quorum_reached");
    expect(reached).toBeDefined();
    expect(JSON.parse(reached!.details_json).reviewers).toEqual(["usr_anna", "usr_bob"]);

    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("records the moment a change was blocked", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" });
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "rejected", reason: "nein" });

    const events = listAuditEvents(db, companyId, { limit: 50 }) as Array<Record<string, string>>;
    const blocked = events.find((e) => e.action === "approval.quorum_blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.actor_id).toBe("usr_bob");
    expect(blocked!.outcome).toBe("denied");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("guards", () => {
  it("refuses a vote on an approval that has already been decided", () => {
    const id = raise();
    approvals.decide(id, "approved", "usr_anna", "eilig");

    expect(() => store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "rejected" })).toThrow(
      /bereits entschieden/,
    );
  });

  it("refuses a vote on an approval that does not exist", () => {
    expect(() => store.record({ approvalId: "apr_missing", reviewerId: "usr_anna", verdict: "approved" })).toThrow(
      /existiert nicht/,
    );
  });

  it("refuses a quorum of zero and a quorum nobody could ever reach", () => {
    const id = raise();
    expect(() => store.setRequiredApprovals(id, 0)).toThrow(/mindestens eine Zustimmung/);
    expect(() => store.setRequiredApprovals(id, 50)).toThrow(/Sackgasse/);
  });

  it("lists reviews in the order the people spoke", () => {
    const id = raise(2);
    store.record({ approvalId: id, reviewerId: "usr_anna", verdict: "approved" }, { now: 1_000 });
    store.record({ approvalId: id, reviewerId: "usr_bob", verdict: "rejected" }, { now: 2_000 });

    expect(store.listFor(id).map((r) => [r.reviewer_id, r.verdict])).toEqual([
      ["usr_anna", "approved"],
      ["usr_bob", "rejected"],
    ]);
  });
});
