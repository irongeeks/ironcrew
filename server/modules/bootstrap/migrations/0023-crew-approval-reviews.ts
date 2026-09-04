// server/modules/bootstrap/migrations/0023-crew-approval-reviews.ts
//
// IronCrew — more than one pair of human eyes on a dangerous decision.
//
// Until now an approval had exactly one decider: `crew_approvals.decided_by`,
// one name, one moment, done. That is the right shape for the overwhelming
// majority of approvals — an owner reads a summary, says yes, work continues.
// It is the wrong shape for the handful that can end a company: a sandbox
// elevation (T-01), a bank transfer, a Tier-0 change. For those, one person is
// a single point of both failure and compromise. Failure: the one owner is on
// holiday, or misreads the summary at 23:40. Compromise: whoever takes over
// that one account owns every gate the product has. Phase 5 asks for multiple
// human reviewers, and this is the table that records them — one row per
// person per approval, with their verdict, when, and why.
//
// The reviews are a *record*, not a second gate bolted next to the first.
// `crew_approvals.status` remains the single answer to "may this proceed";
// what changes is who is allowed to write that answer and on what evidence.
//
// WHY THE QUORUM IS A COLUMN ON THE APPROVAL, NOT A SETTING
//
// `required_approvals` lives on the approval row, defaulting to 1.
//
// The tempting alternative is a company-wide switch: "this installation
// always requires two approvals". It is tempting because it is one decision
// instead of many, and it is wrong for a reason that is easy to predict and
// hard to undo. Most approvals in a working day are routine — a permission
// change, a deployment — and a global two-person rule makes each of them wait
// for a second human who has nothing to add. Within a fortnight somebody
// switches the setting off, and it is off for the bank transfer too. A
// control that makes ordinary work impossible is a control that gets removed
// precisely when it would have mattered.
//
// So the quorum is a property of the thing being decided. A `bank_transfer`
// over some amount is raised with `required_approvals = 2`; the daily work is
// raised with the default 1 and behaves exactly as it did before this
// migration. That also makes the requirement visible where a person reads it —
// on the approval itself, next to the summary and the rollback plan — instead
// of in a settings page nobody opens.
//
// The column is `NOT NULL DEFAULT 1` with `CHECK (required_approvals >= 1)`,
// so every approval that predates this migration keeps its current meaning and
// no approval can be created that needs zero humans.
//
// WHY UNIQUE (approval_id, reviewer_id)
//
// A quorum counts *people*, not clicks. Without this index the second click
// from the same impatient owner — a double submit, a retried request, a
// refreshed tab — silently satisfies a two-person rule on its own, which is
// the exact failure the rule exists to prevent. The database refuses it; the
// store turns that refusal into a readable sentence.
//
// It also makes the four-eyes property structural rather than aspirational:
// with one row per person, "two approvals" can only mean two distinct people.
//
// WHY ONE REJECTION IS DECISIVE AND A QUORUM IS NOT REQUIRED TO REJECT
//
// The two directions are not symmetric, and treating them as if they were is
// a real mistake with a real consequence.
//
//   N approvals are needed to proceed.  ONE rejection stops it.
//
// A quorum to reject would mean that a reviewer who has spotted that the
// destination IBAN is wrong cannot stop the payment until a colleague agrees —
// and if that colleague is on holiday, the dangerous change proceeds *because
// nobody was there to help say no*. Requiring agreement to act is prudence;
// requiring agreement to refrain is a defect. So a rejection is terminal from
// the moment it is written, whatever the approval count already stands at.
//
// This is why the tally is computed from the rows every time instead of being
// latched into a "quorum reached" flag: a rejection that arrives after the
// second approval blocks just as firmly as one that arrives before it. There
// is no window in which the gate has been declared open and can no longer be
// shut.
//
// "THE PERSON WHO RAISED IT CANNOT BE THE ONLY ONE WHO APPROVES IT"
//
// Enforced here as a *mechanism*, decided elsewhere as a *policy*, and that
// split is deliberate.
//
// The mechanism is the UNIQUE index above: at most one review per person, so
// an approval carrying `required_approvals = 2` cannot be satisfied by one
// human however many times they click. Whoever raised it can be at most one of
// the two. Four eyes really are four eyes; nothing further is needed here.
//
// The policy — which kinds of request deserve that treatment — belongs to
// whoever raises the approval, and cannot be resolved by a rule in this table,
// for two reasons:
//
//   1. `crew_approvals.requested_by` is usually an *agent* ("agt_cto"), not a
//      person. A blanket "the requester may not review" check would therefore
//      almost never fire, while looking as though the system were protected.
//      Comfort without effect is worse than an acknowledged gap.
//   2. Where it did fire, it would brick the ordinary installation. A single
//      owner who raises their own sandbox elevation would be unable to approve
//      it, and there is no second owner to ask — the same bricking argument
//      that makes `UserStore` refuse to demote the last active owner.
//
// So a self-approval at a quorum of 1 is recorded honestly and reported as
// such (`selfApproved` in the tally, for a UI that wants to say "raised and
// approved by the same person"), and an approval that must not be decided
// alone is raised with `required_approvals = 2`. That is a decision about the
// action, made by the code that knows the action.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No `abstain` verdict. An abstention is indistinguishable from not having
// looked yet, and giving it a row would let a reviewer appear in the audit
// trail as having participated without ever taking a position.
//
// No named reviewer slots ("this approval must be reviewed by Anna and Bob").
// That is an escalation policy, and it needs an on-call rota to be usable at
// all; a count is honest about what this system can actually promise.
//
// No expiry per review. The approval already expires as a whole
// (`crew_approvals.expires_at`); a second, finer clock would let a quorum
// silently decay and produce the one outcome nobody wants — a change that
// proceeds because a vote timed out.

import type { DatabaseSync } from "node:sqlite";
import { type Migration, hasColumn } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const REVIEWS_TABLE = `
CREATE TABLE IF NOT EXISTS crew_approval_reviews (
  id           TEXT PRIMARY KEY,
  approval_id  TEXT NOT NULL REFERENCES crew_approvals(id) ON DELETE CASCADE,

  -- Denormalised from the approval. An approval never moves between
  -- companies, so this cannot drift; it earns its place by letting "what has
  -- this person reviewed here" be one indexed read, and by giving the audit
  -- append a company without a join.
  company_id   TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,

  -- A real "usr_…" wherever a person is signed in (T-19, docs/IDENTITY.md).
  -- The point of this table is that the audit chain can name each reviewer
  -- individually; a shared constant here would defeat it entirely.
  reviewer_id  TEXT NOT NULL,

  -- Two values, no third. See the header on why 'abstain' is absent.
  verdict      TEXT NOT NULL CHECK (verdict IN ('approved','rejected')),
  -- Why, in the reviewer's words. Empty is allowed for an approval; a
  -- rejection without a reason is useless to the next reader, but that is a
  -- UI prompt rather than a constraint that would lose a legitimate refusal.
  reason       TEXT NOT NULL DEFAULT '',

  reviewed_at  INTEGER NOT NULL DEFAULT (unixepoch()*1000),

  -- One human, one voice. A second click is not a second reviewer.
  UNIQUE (approval_id, reviewer_id)
);

-- The tally reads (approval_id, verdict) and nothing else, so this index
-- answers "how do the votes stand" without touching the rows.
CREATE INDEX IF NOT EXISTS idx_crew_approval_reviews_approval
  ON crew_approval_reviews(approval_id, verdict);

-- "Everything this person has ever waved through", which is the question an
-- investigation actually asks.
CREATE INDEX IF NOT EXISTS idx_crew_approval_reviews_reviewer
  ON crew_approval_reviews(company_id, reviewer_id, reviewed_at);
`;

export const migration: Migration = {
  version: 23,
  description: "approval reviews: one row per human per approval, with the quorum stored on the approval it guards",
  up(db: DatabaseSync): void {
    db.exec(REVIEWS_TABLE);

    // Guarded rather than IF NOT EXISTS, which ALTER TABLE does not offer.
    // Existing rows take the default and keep behaving exactly as before:
    // one owner, one decision.
    if (!hasColumn(db, "crew_approvals", "required_approvals")) {
      db.exec(
        `ALTER TABLE crew_approvals
           ADD COLUMN required_approvals INTEGER NOT NULL DEFAULT 1
           CHECK (required_approvals >= 1)`,
      );
    }

    log.info({ version: 23 }, "approval review table and per-approval quorum ensured");
  },
};
