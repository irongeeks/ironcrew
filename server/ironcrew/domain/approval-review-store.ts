/**
 * IronCrew — several humans on one approval.
 *
 * `ApprovalEngine.decide()` records one owner's verdict and closes the gate.
 * That is the right shape for almost everything. For the few actions that can
 * end a company — a sandbox elevation (T-01), a payment, a Tier-0 change — one
 * person is a single point of both failure and compromise, so migration 0023
 * gives an approval a quorum (`required_approvals`, default 1) and this store
 * gathers the individual verdicts that satisfy it.
 *
 * THE THREE RULES, IN ONE PLACE
 *
 * 1. **A quorum counts people, not clicks.** `UNIQUE (approval_id,
 *    reviewer_id)` in the schema; a readable refusal here. A double submit is
 *    not a second reviewer.
 * 2. **One rejection is decisive.** N approvals let a change proceed; a single
 *    rejection stops it, immediately and permanently. Requiring agreement to
 *    act is prudence; requiring agreement to refrain would mean a dangerous
 *    change proceeds because the second reviewer was on holiday.
 * 3. **The tally is computed, never latched.** `tally()` reads the rows every
 *    time, so a rejection that arrives *after* the quorum was satisfied blocks
 *    just as firmly as one that arrives before it. There is no moment at which
 *    the gate has been declared open and can no longer be shut.
 *
 * This store deliberately does not write `crew_approvals.status`. A review is
 * evidence; turning evidence into a decision stays with `ApprovalEngine`, so
 * there remains exactly one place that answers "may this proceed" — the caller
 * asks `tally()` and then calls `decide()` itself.
 *
 * User-facing messages are German, as in the sibling stores; comments and
 * audit actions stay English.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export const REVIEW_VERDICTS = ["approved", "rejected"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ApprovalReviewRow {
  id: string;
  approval_id: string;
  company_id: string;
  reviewer_id: string;
  verdict: ReviewVerdict;
  reason: string;
  reviewed_at: number;
}

const COLUMNS = `id, approval_id, company_id, reviewer_id, verdict, reason, reviewed_at`;

/**
 * The whole state of a vote in one object, so a caller asks one question
 * instead of assembling the answer from three counts and getting the
 * precedence between them wrong.
 */
export interface ApprovalTally {
  /** How many distinct people have approved. */
  approvals: number;
  /** How many have rejected. One is enough to matter. */
  rejections: number;
  /** The quorum this was measured against. */
  required: number;
  /** Enough approvals *and* nobody has rejected. The only "go" signal. */
  satisfied: boolean;
  /** Somebody rejected. Terminal, regardless of the approval count. */
  blocked: boolean;
  /**
   * How many further approvals are still needed. Zero when satisfied — and
   * zero when blocked, because no number of further approvals can revive a
   * rejected change. A caller showing "waiting for 1 more" must not show it
   * next to a rejection.
   */
  outstanding: number;
  /**
   * The approval's own requester is among those who approved. Only reachable
   * at a quorum of 1 in any meaningful sense — with `required_approvals >= 2`
   * the UNIQUE index guarantees a second, different human — and surfaced so a
   * UI can say "raised and approved by the same person" rather than hiding it.
   */
  selfApproved: boolean;
}

export class ApprovalReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalReviewError";
  }
}

/** Only the approval columns this store needs; `ApprovalEngine` owns the rest. */
interface ApprovalContextRow {
  id: string;
  company_id: string;
  task_id: string | null;
  run_id: string | null;
  requested_by: string;
  approval_type: string;
  status: string;
  correlation_id: string;
  required_approvals: number;
}

export interface RecordReviewInput {
  approvalId: string;
  /** A real `usr_…` for a signed-in person (T-19, docs/IDENTITY.md). */
  reviewerId: string;
  verdict: ReviewVerdict;
  reason?: string;
}

export interface ReviewOpts {
  actorType?: ActorType;
  now?: number;
}

/**
 * A quorum larger than the number of people who could ever satisfy it is a
 * deadlock dressed as diligence. Five is far above any real four-eyes rule and
 * still refuses the typo that asks for fifty.
 */
export const MAX_REQUIRED_APPROVALS = 5;

export class ApprovalReviewStore {
  constructor(private readonly db: DatabaseSync) {}

  private approval(approvalId: string): ApprovalContextRow | null {
    return oneRow<ApprovalContextRow>(
      this.db.prepare(
        `SELECT id, company_id, task_id, run_id, requested_by, approval_type, status,
                correlation_id, required_approvals
           FROM crew_approvals WHERE id = ?`,
      ),
      approvalId,
    );
  }

  private requireApproval(approvalId: string): ApprovalContextRow {
    const approval = this.approval(approvalId);
    if (!approval) throw new ApprovalReviewError("Diese Freigabe existiert nicht (mehr).");
    return approval;
  }

  /**
   * Records one human's verdict.
   *
   * The tally is recomputed before and after, so the audit chain can carry the
   * *moment* a quorum was reached or a change was blocked, rather than leaving
   * that to be inferred later by whoever counts the rows correctly.
   */
  record(input: RecordReviewInput, opts: ReviewOpts = {}): ApprovalReviewRow {
    const now = opts.now ?? Date.now();
    const reviewerId = input.reviewerId.trim();
    const reason = (input.reason ?? "").trim();

    if (!reviewerId) throw new ApprovalReviewError("Eine Bewertung braucht eine Person, die sie abgibt.");
    if (!(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
      throw new ApprovalReviewError(`Unbekanntes Votum "${input.verdict}".`);
    }

    const approval = this.requireApproval(input.approvalId);

    // Votes are gathered while the request is open. Once the approval itself
    // has been decided, expired or cancelled, a late voice changes nothing —
    // and recording it would suggest it did.
    if (approval.status !== "pending") {
      throw new ApprovalReviewError(
        "Über diese Freigabe wurde bereits entschieden. Eine nachträgliche Stimme ändert daran nichts.",
      );
    }

    // Checked here for the readable message; the UNIQUE index is what actually
    // decides, so a concurrent double submit still loses (see the catch).
    //
    // "Du", not the reviewer's id: only the person themselves can trigger
    // their own duplicate — `reviewerId` comes from the session, never from
    // the request body — so the one human who will ever read this sentence is
    // its subject. Naming them would mean showing a `usr_…` to the account it
    // belongs to, which reads as a system error rather than an explanation.
    if (this.byReviewer(approval.id, reviewerId)) {
      throw new ApprovalReviewError(
        "Du hast diese Freigabe bereits bewertet. Ein zweiter Klick ist kein zweiter Prüfer.",
      );
    }

    const before = this.tallyFor(approval);
    const id = newId("dec");

    try {
      this.db
        .prepare(
          `INSERT INTO crew_approval_reviews
             (id, approval_id, company_id, reviewer_id, verdict, reason, reviewed_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, approval.id, approval.company_id, reviewerId, input.verdict, reason, now);
    } catch (err) {
      // Lost the race to another request from the same person. Translate the
      // constraint rather than let a raw SQLite error surface as a 500: a
      // duplicate vote is a bad request, not a broken server.
      if (this.byReviewer(approval.id, reviewerId)) {
        throw new ApprovalReviewError(
          "Du hast diese Freigabe bereits bewertet. Ein zweiter Klick ist kein zweiter Prüfer.",
        );
      }
      throw err;
    }

    const after = this.tallyFor(approval);

    // `actor_type` stays "owner" for a human even when that human is an
    // operator (docs/IDENTITY.md); `actor_id` is the reviewer, which is the
    // entire point of this table.
    const actorType = opts.actorType ?? "owner";
    appendAuditEvent(this.db, {
      companyId: approval.company_id,
      actorType,
      actorId: reviewerId,
      action: `approval.review_${input.verdict}`,
      entityType: "approval_review",
      entityId: id,
      taskId: approval.task_id,
      runId: approval.run_id,
      approvalId: approval.id,
      outcome: input.verdict === "approved" ? "ok" : "denied",
      correlationId: approval.correlation_id,
      details: {
        approvalType: approval.approval_type,
        reason,
        approvals: after.approvals,
        rejections: after.rejections,
        required: after.required,
        outstanding: after.outstanding,
      },
    });

    // The transition, not the state: exactly one entry marks the moment the
    // gate could open, and one marks the moment it was shut.
    if (!before.blocked && after.blocked) {
      appendAuditEvent(this.db, {
        companyId: approval.company_id,
        actorType,
        actorId: reviewerId,
        action: "approval.quorum_blocked",
        entityType: "approval",
        entityId: approval.id,
        taskId: approval.task_id,
        runId: approval.run_id,
        approvalId: approval.id,
        outcome: "denied",
        correlationId: approval.correlation_id,
        details: { approvalType: approval.approval_type, approvals: after.approvals, required: after.required },
      });
    } else if (!before.satisfied && after.satisfied) {
      appendAuditEvent(this.db, {
        companyId: approval.company_id,
        actorType,
        actorId: reviewerId,
        action: "approval.quorum_reached",
        entityType: "approval",
        entityId: approval.id,
        taskId: approval.task_id,
        runId: approval.run_id,
        approvalId: approval.id,
        correlationId: approval.correlation_id,
        details: {
          approvalType: approval.approval_type,
          required: after.required,
          reviewers: this.listFor(approval.id).map((r) => r.reviewer_id),
        },
      });
    }

    return this.get(id)!;
  }

  get(id: string): ApprovalReviewRow | null {
    return oneRow<ApprovalReviewRow>(this.db.prepare(`SELECT ${COLUMNS} FROM crew_approval_reviews WHERE id = ?`), id);
  }

  byReviewer(approvalId: string, reviewerId: string): ApprovalReviewRow | null {
    return oneRow<ApprovalReviewRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_approval_reviews WHERE approval_id = ? AND reviewer_id = ?`),
      approvalId,
      reviewerId,
    );
  }

  /** In the order the people actually spoke — that is the story of the decision. */
  listFor(approvalId: string): ApprovalReviewRow[] {
    return allRows<ApprovalReviewRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_approval_reviews
          WHERE approval_id = ? ORDER BY reviewed_at ASC, rowid ASC`,
      ),
      approvalId,
    );
  }

  /**
   * Where a vote stands.
   *
   * `requiredApprovals` normally comes from the approval row; pass it only to
   * ask a hypothetical ("what would a quorum of two say about this?"). An
   * unknown approval is an error rather than an empty tally, because an empty
   * tally of a non-existent approval reads as "nobody has rejected it yet".
   */
  tally(approvalId: string, requiredApprovals?: number): ApprovalTally {
    return this.tallyFor(this.requireApproval(approvalId), requiredApprovals);
  }

  private tallyFor(approval: ApprovalContextRow, requiredApprovals?: number): ApprovalTally {
    const rows = allRows<{ verdict: ReviewVerdict; reviewer_id: string }>(
      this.db.prepare("SELECT verdict, reviewer_id FROM crew_approval_reviews WHERE approval_id = ?"),
      approval.id,
    );

    const approvals = rows.filter((r) => r.verdict === "approved").length;
    const rejections = rows.length - approvals;
    const required = Math.max(1, Math.trunc(requiredApprovals ?? approval.required_approvals ?? 1));

    // Rule 2, in one line: a rejection outranks any number of approvals.
    const blocked = rejections > 0;
    const satisfied = !blocked && approvals >= required;

    return {
      approvals,
      rejections,
      required,
      satisfied,
      blocked,
      outstanding: blocked ? 0 : Math.max(0, required - approvals),
      selfApproved: rows.some((r) => r.verdict === "approved" && r.reviewer_id === approval.requested_by),
    };
  }

  /**
   * Raises (or lowers) the quorum on a single approval.
   *
   * The column belongs to this feature, so its writer lives here rather than
   * in `ApprovalEngine`. Only while the approval is pending: changing what a
   * decision required *after* it was taken would rewrite history in the one
   * place that must not be rewritable.
   */
  setRequiredApprovals(
    approvalId: string,
    required: number,
    opts: ReviewOpts & { actorId?: string } = {},
  ): ApprovalTally {
    const approval = this.requireApproval(approvalId);

    if (!Number.isInteger(required) || required < 1) {
      throw new ApprovalReviewError("Eine Freigabe braucht mindestens eine Zustimmung.");
    }
    if (required > MAX_REQUIRED_APPROVALS) {
      throw new ApprovalReviewError(
        `Mehr als ${MAX_REQUIRED_APPROVALS} Zustimmungen sind keine Vorsicht mehr, sondern eine Sackgasse.`,
      );
    }
    if (approval.status !== "pending") {
      throw new ApprovalReviewError("Über diese Freigabe wurde bereits entschieden.");
    }

    this.db.prepare("UPDATE crew_approvals SET required_approvals = ? WHERE id = ?").run(required, approvalId);

    appendAuditEvent(this.db, {
      companyId: approval.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "approval.quorum_set",
      entityType: "approval",
      entityId: approvalId,
      taskId: approval.task_id,
      runId: approval.run_id,
      approvalId,
      correlationId: approval.correlation_id,
      details: { approvalType: approval.approval_type, from: approval.required_approvals, to: required },
    });

    return this.tally(approvalId);
  }
}
