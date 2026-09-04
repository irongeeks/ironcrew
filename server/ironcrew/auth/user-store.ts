/**
 * IronCrew — user accounts.
 *
 * Migration 0017 explains why this table exists at all: an audit log whose
 * every entry names the same fictional actor proves the wrong thing carefully.
 * This store is the other half of that — the only place a password is turned
 * into a stored hash, and the only place a role changes.
 *
 * THREE STRUCTURAL GUARANTEES, RATHER THAN CONVENTIONS TO REMEMBER
 *
 * 1. `UserRow` has no `password_hash` field, and every query here names its
 *    columns explicitly instead of `SELECT *`. A user row therefore cannot be
 *    serialised into an API response with its hash attached, because the value
 *    is never in the object — the same trick `MailboxRow` uses for credentials
 *    and `crew_vessels` uses for its absent permission column. The hash is
 *    read exactly once, inside `authenticate`, into a local variable that
 *    never leaves the method.
 * 2. Email is normalised to lowercase on the way in and looked up normalised.
 *    Two accounts differing only in capitalisation are an impersonation
 *    waiting to happen, so `robert@` and `Robert@` are the same account and
 *    the second attempt is a `UserMutationError`, never a raw constraint
 *    crash the API would surface as a 500.
 * 3. There is always an owner. `update` will not demote or disable the last
 *    active owner and `delete` will not remove them. A system with no owner
 *    has nobody who can approve anything or create a new owner: it is bricked,
 *    and no amount of "the operator should have known better" un-bricks it.
 *    This is the most important rule in this file.
 *
 * Errors are English here, as in every sibling store — German belongs in the
 * UI layer that renders these failures, not in the domain.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { allRows, oneRow } from "../domain/sql.ts";
import { appendAuditEvent, type ActorType } from "../domain/audit.ts";
import { hashPassword, verifyPassword } from "../../security/password.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-users" });

/**
 * Coarse on purpose (migration 0017): three roles that map to real jobs beat a
 * permission matrix nobody maintains. Approving is the owner's alone.
 */
export const USER_ROLES = ["owner", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value as string);
}

export function isUserStatus(value: unknown): value is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(value as string);
}

/**
 * Deliberately without `password_hash` — see guarantee 1 in this module's
 * doc-comment. Do not add it "just for the store's own convenience": the
 * absence is the mechanism.
 */
export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

const USER_COLUMNS = `id, email, display_name, role, status, last_login_at, created_at, updated_at`;

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
}

/** Who is performing the mutation, and which company's chain records it. */
export interface UserMutationOpts {
  actorType?: ActorType;
  actorId?: string;
  companyId?: string;
}

export class UserMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserMutationError";
  }
}

/**
 * Twelve characters, no composition rules.
 *
 * NIST SP 800-63B permits eight, but that floor assumes an online-only attack
 * against a rate-limited endpoint. IronCrew is a single SQLite file that gets
 * copied to backups, laptops and support tickets, so the realistic attack is
 * offline against a stolen file — and against offline scrypt the only knob
 * that raises the attacker's cost is length. Composition rules ("one digit,
 * one symbol") are deliberately absent: they push people towards predictable
 * mutations of short words, which is the opposite of what helps here.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * An upper bound so a login form cannot be used to make the server spend
 * unbounded time hashing. Generous enough that no real passphrase or password
 * manager output comes near it.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * A syntactically valid scrypt hash that nothing verifies against.
 *
 * `authenticate` runs a real verification against this when the email is
 * unknown, so that path spends the same ~50 ms of scrypt as a wrong password
 * does. Skipping the work for an unknown email would make the login endpoint
 * an account enumerator: "instant no" means no such user, "slow no" means the
 * account exists. Built from constant bytes rather than a real hash, so it
 * never has to be kept in sync with a password someone knows.
 */
const DUMMY_PASSWORD_HASH = `scrypt:${Buffer.alloc(16).toString("base64")}:${Buffer.alloc(64).toString("base64")}`;

/**
 * Lowercased and trimmed. Case-insensitivity is enforced here rather than by a
 * `COLLATE NOCASE` index, because SQLite's NOCASE is ASCII-only and would
 * quietly treat `MÜLLER@` and `müller@` as two accounts.
 */
function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Deliberately loose. Full RFC 5322 validation rejects addresses that real
 * mail servers accept, and this field is a login handle rather than a delivery
 * target — the only things that actually break downstream are an empty value,
 * embedded whitespace, and a missing local or domain part.
 */
function assertEmailShape(email: string): void {
  if (email.length === 0) throw new UserMutationError("A user needs an email address.");
  if (/\s/.test(email)) throw new UserMutationError("An email address cannot contain whitespace.");
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    throw new UserMutationError(`"${email}" is not a valid email address.`);
  }
}

function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserMutationError(`A password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new UserMutationError(`A password may be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export class UserStore {
  constructor(private readonly db: DatabaseSync) {}

  // --- audit plumbing -----------------------------------------------------

  /**
   * Users are global — one account signs into the whole installation — while
   * the audit chain is per company. A user event therefore has to be filed
   * under *some* company. The caller names it via `opts.companyId`; when it
   * does not (a CLI bootstrapping the first account, say) we file under the
   * single company row that a single-tenant install has.
   *
   * With no company there is nowhere to file and no chain to break, so the
   * event is skipped rather than invented. With several, guessing would put
   * the event in the wrong chain, so the caller has to be explicit — we warn
   * instead, because silently dropping a governance event is the failure mode
   * worth being able to find in the logs.
   */
  private auditCompanyId(explicit: string | undefined, action: string): string | null {
    if (explicit) return explicit;
    const rows = allRows<{ id: string }>(this.db.prepare("SELECT id FROM crew_companies ORDER BY rowid ASC LIMIT 2"));
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) {
      log.warn({ action }, "user event not audited: several companies exist and no companyId was given");
    }
    return null;
  }

  private audit(opts: UserMutationOpts, action: string, userId: string, details: Record<string, unknown>): void {
    const companyId = this.auditCompanyId(opts.companyId, action);
    if (!companyId) return;
    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action,
      entityType: "user",
      entityId: userId,
      // Metadata only. Never the hash, never the password, and never even its
      // length — a length is a search-space hint handed to whoever reads the
      // log, which for an audit log is deliberately many people.
      details,
    });
  }

  // --- reads --------------------------------------------------------------

  count(): number {
    return oneRow<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM crew_users"))?.n ?? 0;
  }

  get(id: string): UserRow | null {
    return oneRow<UserRow>(this.db.prepare(`SELECT ${USER_COLUMNS} FROM crew_users WHERE id = ?`), id);
  }

  byEmail(email: string): UserRow | null {
    return oneRow<UserRow>(
      this.db.prepare(`SELECT ${USER_COLUMNS} FROM crew_users WHERE email = ?`),
      normaliseEmail(email),
    );
  }

  /** Creation order, so the account that bootstrapped the install lists first. */
  list(): UserRow[] {
    return allRows<UserRow>(
      this.db.prepare(`SELECT ${USER_COLUMNS} FROM crew_users ORDER BY created_at ASC, rowid ASC`),
    );
  }

  /** How many accounts could still approve something today. */
  private activeOwnerCount(): number {
    return (
      oneRow<{ n: number }>(
        this.db.prepare("SELECT COUNT(*) AS n FROM crew_users WHERE role = 'owner' AND status = 'active'"),
      )?.n ?? 0
    );
  }

  /**
   * The "there is always an owner" guard. `next` describes what the account
   * would look like afterwards; when the change would take the installation
   * from one active owner to none, it is refused.
   */
  private assertOwnerSurvives(user: UserRow, next: { role: UserRole; status: UserStatus }, verb: string): void {
    const stillActiveOwner = next.role === "owner" && next.status === "active";
    if (user.role !== "owner" || user.status !== "active" || stillActiveOwner) return;
    if (this.activeOwnerCount() > 1) return;
    throw new UserMutationError(
      `Refusing to ${verb} the last active owner: without one, nobody can approve anything or create a new owner.`,
    );
  }

  // --- writes -------------------------------------------------------------

  /**
   * Creates an account. Hashing happens only after every cheap check has
   * passed, so a bad request never costs ~50 ms of scrypt.
   *
   * The very first account defaults to `owner` rather than to the schema's
   * `viewer`: migration 0017 notes that the legacy single-password path stops
   * being an implicit owner the moment a user exists, so an installation whose
   * only user is a viewer would be bricked on creation. An explicit role is
   * still honoured — the caller may know better — but the default never
   * bricks. Use `count()` to detect the bootstrap case from outside.
   */
  async create(input: CreateUserInput, opts: UserMutationOpts = {}): Promise<UserRow> {
    const email = normaliseEmail(input.email);
    assertEmailShape(email);
    assertPasswordAcceptable(input.password);

    const role = input.role ?? (this.count() === 0 ? "owner" : "viewer");
    if (!isUserRole(role)) throw new UserMutationError(`Unknown role "${role}".`);

    if (this.byEmail(email)) {
      throw new UserMutationError(`A user with the email "${email}" already exists.`);
    }

    const passwordHash = await hashPassword(input.password);
    const id = newId("usr");
    try {
      this.db
        .prepare(
          `INSERT INTO crew_users (id, email, display_name, password_hash, role, status)
           VALUES (?,?,?,?,?, 'active')`,
        )
        .run(id, email, input.displayName?.trim() ?? "", passwordHash, role);
    } catch (err) {
      // The pre-check above loses to a concurrent insert; the unique index is
      // what actually decides. Translate rather than let a raw SQLite error
      // reach the API as a 500 — a duplicate email is a bad request.
      if (this.byEmail(email)) {
        throw new UserMutationError(`A user with the email "${email}" already exists.`);
      }
      throw err;
    }

    this.audit(opts, "user.created", id, { email, role });
    return this.get(id)!;
  }

  update(id: string, patch: UpdateUserInput, opts: UserMutationOpts = {}): UserRow | null {
    const user = this.get(id);
    if (!user) return null;

    if (patch.role !== undefined && !isUserRole(patch.role)) {
      throw new UserMutationError(`Unknown role "${patch.role}".`);
    }
    if (patch.status !== undefined && !isUserStatus(patch.status)) {
      throw new UserMutationError(`Unknown status "${patch.status}".`);
    }

    const nextRole = patch.role ?? user.role;
    const nextStatus = patch.status ?? user.status;
    this.assertOwnerSurvives(
      user,
      { role: nextRole, status: nextStatus },
      patch.role !== undefined ? "demote" : "disable",
    );

    this.db
      .prepare(
        `UPDATE crew_users
            SET display_name = COALESCE(?, display_name),
                role = ?,
                status = ?,
                updated_at = unixepoch()*1000
          WHERE id = ?`,
      )
      .run(patch.displayName === undefined ? null : patch.displayName.trim(), nextRole, nextStatus, id);

    // One audit event per thing that actually changed. A display-name edit is
    // cosmetic and stays out of the chain; a role or status change is a
    // change to what this account may do, which is exactly what the chain is
    // for.
    if (nextRole !== user.role) {
      this.audit(opts, "user.role_changed", id, { email: user.email, from: user.role, to: nextRole });
    }
    if (nextStatus !== user.status) {
      // `user.enabled` is not in the original action list, but re-granting
      // access is as much a governance event as withdrawing it; leaving it
      // unaudited would let an account be quietly restored.
      this.audit(opts, nextStatus === "disabled" ? "user.disabled" : "user.enabled", id, { email: user.email });
    }

    return this.get(id);
  }

  async setPassword(id: string, password: string, opts: UserMutationOpts = {}): Promise<UserRow | null> {
    const user = this.get(id);
    if (!user) return null;
    assertPasswordAcceptable(password);

    const passwordHash = await hashPassword(password);
    this.db
      .prepare("UPDATE crew_users SET password_hash = ?, updated_at = unixepoch()*1000 WHERE id = ?")
      .run(passwordHash, id);

    this.audit(opts, "user.password_changed", id, { email: user.email });
    return this.get(id);
  }

  /**
   * Verifies credentials.
   *
   * Returns null for an unknown email, a wrong password and a disabled
   * account alike. The three are not distinguishable by the caller, and not
   * by the obvious timing channel either: the unknown-email path still runs a
   * full scrypt verification against `DUMMY_PASSWORD_HASH`, and a disabled
   * account is verified against its real hash before the status is even
   * looked at. (This equalises the work we control. It cannot equalise
   * everything — cache effects and a database that grows are not ours to
   * flatten — but it removes the difference that is trivially measurable
   * across a network: present-vs-absent scrypt.)
   */
  async authenticate(email: string, password: string, opts: { now?: number } = {}): Promise<UserRow | null> {
    const now = opts.now ?? Date.now();
    const row = oneRow<{ id: string; password_hash: string; status: UserStatus }>(
      this.db.prepare("SELECT id, password_hash, status FROM crew_users WHERE email = ?"),
      normaliseEmail(email),
    );

    // Over-long input is rejected without hashing, exactly as on create — the
    // bound exists to stop a login form buying unbounded server work.
    if (password.length > MAX_PASSWORD_LENGTH) return null;

    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !ok || row.status !== "active") return null;

    // Only `last_login_at`. `updated_at` means "the account record changed",
    // and signing in does not change the account — bumping it would make
    // every login look like an administrative edit.
    this.db.prepare("UPDATE crew_users SET last_login_at = ? WHERE id = ?").run(now, row.id);
    return this.get(row.id);
  }

  /**
   * Removes an account outright.
   *
   * Disabling is the documented default and `delete` is the exception. A
   * disabled account keeps its history: every audit entry that names it still
   * resolves to a person with an email and a display name, and its sessions
   * stop resolving immediately (see SessionStore). A deleted account orphans
   * that history — the entries survive, because the chain forbids deleting
   * them, but they now name an id nothing can resolve, and "who did this"
   * becomes unanswerable. Delete for a mistyped account created minutes ago;
   * disable for a person who has left.
   */
  delete(id: string, opts: UserMutationOpts = {}): void {
    const user = this.get(id);
    if (!user) return;
    this.assertOwnerSurvives(user, { role: "viewer", status: "disabled" }, "delete");

    // Sessions go with it via ON DELETE CASCADE (migration 0017).
    this.db.prepare("DELETE FROM crew_users WHERE id = ?").run(id);
    this.audit(opts, "user.deleted", id, { email: user.email, role: user.role });
  }
}
