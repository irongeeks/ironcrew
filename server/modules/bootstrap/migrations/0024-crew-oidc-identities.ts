// server/modules/bootstrap/migrations/0024-crew-oidc-identities.ts
//
// IronCrew — an account may also be proven by an identity provider.
//
// Migration 0017 gave the installation accounts, roles and sessions, and one
// way to prove you are one of them: a password this system stores the scrypt
// hash of. That is the right default for a self-hosted single-operator box.
// It stops being the right *only* option the moment an MSP already runs a
// directory — Authentik, in the case this was written for — where joining and
// leaving the company is a thing that happens once, centrally, and where
// everybody's second factor already lives. Two places to switch an account
// off means one place somebody forgets, and the account they forget is the
// one that belonged to the person who left.
//
// So: a second way to prove *who*, feeding the same crew session the rest of
// the system already understands (docs/IDENTITY.md). Not a second kind of
// principal, not a second role model, not a second audit actor — the SSO
// login ends in exactly the row `crew_sessions` would hold after a password
// login, and `actor_id` stays the same `usr_…`.
//
// WHY A TABLE, AND NOT TWO COLUMNS ON `crew_users`
//
// The obvious cheap version is `oidc_issuer` / `oidc_subject` on
// `crew_users`. It is wrong in two directions that both show up in real
// installations:
//
//  1. **A person may have both, and needs to.** The operator who configures
//     SSO must be able to keep their password login working, because the day
//     the identity provider is down or misconfigured is exactly the day
//     somebody has to sign in and fix it. A column pair invites the reading
//     "an account is either a password account or an SSO account"; a link
//     table says plainly that an account is a person, and a credential is a
//     way of proving you are them. `crew_users.password_hash` stays NOT NULL
//     for the same reason — nullable-as-"no password means anyone" was
//     refused in 0017 and is refused again here.
//  2. **An installation may federate more than one issuer.** An MSP with a
//     staff directory and a customer-facing tenant has two, and a migration
//     from one Authentik to another has two for as long as the move takes.
//     Columns force one; a row per (issuer, subject) allows the second
//     without a schema change, and makes "which directory does this person
//     come from" a query rather than a guess.
//
// The uniqueness rule is the composite PRIMARY KEY (issuer, subject): one
// directory identity maps to at most one local account. There is deliberately
// no surrogate `id`: nothing else in the schema references a link row, and
// the natural key is the thing the rest of the code actually looks up.
//
// WHY THE SUBJECT IS THE JOIN KEY, AND THE EMAIL IS NOT
//
// `sub` is the one claim OIDC Core requires to be locally unique within the
// issuer and *never reassigned*. An email address is neither. It changes when
// someone marries, it changes when the company renames its domain, and — the
// case that actually costs you — it gets handed to the next person with the
// same name after the first one leaves. Joining on email means that new
// person inherits the old one's account, their role and their history, and
// the audit log will state, correctly per its own rules and falsely in fact,
// that they did things they were not there for.
//
// So the email is stored here only as `email_at_link`: what the directory
// said about this subject on the day the link was made, useful for an
// operator looking at the list and never consulted to decide anything. The
// local email on `crew_users` remains the local email.
//
// WHAT HAPPENS ON THE FIRST SSO LOGIN OF AN UNKNOWN SUBJECT
//
// The decision, and the argument, because this is the line that decides how
// much authority the directory has over this system:
//
// **Default: nothing is created. The login is refused, by name.** An unknown
// subject gets a message naming the issuer and the subject so an owner can
// pre-create the account (or link it) in ten seconds, and the login is
// rejected fail-closed.
//
// The alternatives, and why they are options rather than the default:
//
//  - *Auto-create as `owner`* hands the directory the ability to mint owners.
//    An owner approves irreversible acts (T-01), grants tools, and reads the
//    vault. Anyone who can create a user in Authentik — an Authentik admin, a
//    helpdesk account with user-write, or whoever compromises it — would then
//    be able to create an IronCrew owner without any IronCrew owner deciding
//    anything. That is a strictly weaker path to the strongest role than the
//    one 0017 was careful to build, so it is never available: the
//    provisioning option refuses `owner` outright.
//  - *Auto-create as `viewer`* is bounded but not small. IronCrew has no
//    per-object permissions on purpose (docs/IDENTITY.md), so a viewer reads
//    every customer's projects, tasks and mail. In an installation whose
//    Authentik also serves customers or contractors, "everyone in the
//    directory can read everything" is a data leak with a config file behind
//    it. Available as an explicit opt-in (`create`, at a configured role that
//    defaults to `viewer`), because for a company whose directory contains
//    only its own staff it is genuinely what they want — but chosen, not
//    inherited.
//  - *Refusing entirely* does cost an admin one pre-created account per
//    person. For a system with a handful of accounts that is a small,
//    once-per-hire cost, and it buys the property worth keeping: the local
//    user list stays the authoritative statement of *who may use this
//    system*, while the directory only proves *who someone is*. That is the
//    same split password login already has — the account is the grant, the
//    credential is only the proof — and it is why refusing is the default.
//
// A third mode, `link-verified-email`, exists between them: an unknown
// subject may attach itself to an *existing* local account when the ID token
// carries a matching address with `email_verified: true`. It creates no
// account and grants no role — it only saves the operator from typing a
// subject by hand — and it consults the email exactly once, at link time.
// From the next login on, the subject decides and the email never does again.
// It requires `email_verified` because an issuer that lets a user set their
// own unverified address would otherwise let that user claim the owner's
// account by typing the owner's address into their profile.
//
// The bootstrap rule from 0017 survives all three: while `crew_users` is
// empty, SSO provisions nobody. The first account is an owner, and an owner
// is created deliberately by a human at the console — not by whoever happens
// to log in first through a directory that was just pointed at this box.
//
// NOBODY IS LOCKED OUT BY THIS MIGRATION
//
// It creates no rows and changes no existing table. An installation with no
// OIDC configuration never reads this table, and password login is untouched.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_oidc_identities (
  -- The issuer identifier exactly as it appears in the ID token's \`iss\`
  -- claim, which OIDC Discovery requires to equal the \`issuer\` value in the
  -- provider's discovery document. Stored rather than assumed, so an
  -- installation that federates a second directory keeps the two apart.
  issuer        TEXT NOT NULL,

  -- The \`sub\` claim: locally unique at the issuer and never reassigned.
  -- This is the join key. See the header for why the email is not.
  subject       TEXT NOT NULL,

  user_id       TEXT NOT NULL REFERENCES crew_users(id) ON DELETE CASCADE,

  -- What the directory said about this subject when the link was made.
  -- Descriptive only: shown to an operator reviewing links, never used to
  -- resolve a login. An email that changes upstream does not move an account.
  email_at_link TEXT NOT NULL DEFAULT '',

  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  last_login_at INTEGER,

  -- One directory identity, at most one local account. This composite key IS
  -- the uniqueness rule; a separate UNIQUE index would only restate it.
  PRIMARY KEY (issuer, subject)
);

-- "Which directory identities does this account have" — needed to show them
-- on the user page, and to unlink them. The primary key indexes the other
-- direction already.
CREATE INDEX IF NOT EXISTS idx_crew_oidc_identities_user
  ON crew_oidc_identities(user_id);
`;

export const migration: Migration = {
  version: 24,
  description: "OIDC identities: a directory subject may prove an existing crew account",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    log.info({ version: 24 }, "crew_oidc_identities ensured");
  },
};
