/**
 * IronCrew — who may talk to the executive assistant, and with what authority.
 *
 * Inbound chat is an open door unless someone is checking who is at it. A bot
 * token is not a secret: anyone who finds the bot can message it. So every
 * inbound message is resolved to a pairing first, and the pairing decides
 * between three outcomes:
 *
 *   no row / pending / blocked   →  nothing happens beyond a pairing prompt
 *   active + role "guest"        →  routed like incoming mail: an `inbox`
 *                                   task, quoted as third-party content
 *   active + role "owner"        →  reaches handleCeoMessage(), i.e. speaks
 *                                   with the owner's authority
 *
 * That last line is the reason this module exists. `handleCeoMessage()`
 * treats its text as the owner speaking and can delegate work immediately —
 * so "owner" is not a label on a contact, it is the authority to act as the
 * CEO through a chat app, and it is only ever granted by the owner in the
 * Command Center where they can see who is asking.
 *
 * The pairing code is short-lived and single-use. It proves nothing on its
 * own — it is a handle for the owner to point at the right stranger, not a
 * password. The decision is always the owner's.
 */

import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { sanitiseLine } from "../policy/untrusted-content.ts";

export const PAIRING_ROLES = ["owner", "guest"] as const;
export type PairingRole = (typeof PAIRING_ROLES)[number];

export const PAIRING_STATUSES = ["pending", "active", "blocked"] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];

/** How long a code is worth offering. Long enough to walk to a laptop. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export interface MessengerPairingRow {
  id: string;
  company_id: string;
  channel_kind: string;
  chat_id: string;
  sender_id: string;
  display_name: string;
  role: PairingRole;
  status: PairingStatus;
  pairing_code: string;
  code_expires_at: number | null;
  paired_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, company_id, channel_kind, chat_id, sender_id, display_name, role, status,
  pairing_code, code_expires_at, paired_at, last_seen_at, created_at, updated_at`;

export class MessengerPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessengerPairingError";
  }
}

/** What an inbound message is allowed to do. */
export type PairingDecision =
  | { allow: "ceo"; pairing: MessengerPairingRow }
  | { allow: "guest"; pairing: MessengerPairingRow }
  | { allow: "none"; pairing: MessengerPairingRow | null; reason: "pending" | "blocked" | "unknown" };

function sixDigitCode(): string {
  // Six digits is enough to disambiguate one stranger from another in the
  // Command Center. It is not a secret and is not treated as one.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export class MessengerPairingStore {
  constructor(private readonly db: DatabaseSync) {}

  find(companyId: string, channelKind: string, senderId: string): MessengerPairingRow | null {
    return oneRow<MessengerPairingRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_messenger_pairings
          WHERE company_id = ? AND channel_kind = ? AND sender_id = ?`,
      ),
      companyId,
      channelKind,
      senderId,
    );
  }

  get(id: string): MessengerPairingRow | null {
    return oneRow<MessengerPairingRow>(
      this.db.prepare(`SELECT ${COLUMNS} FROM crew_messenger_pairings WHERE id = ?`),
      id,
    );
  }

  list(companyId: string): MessengerPairingRow[] {
    return allRows<MessengerPairingRow>(
      this.db.prepare(
        `SELECT ${COLUMNS} FROM crew_messenger_pairings
          WHERE company_id = ? ORDER BY channel_kind, display_name, sender_id`,
      ),
      companyId,
    );
  }

  /**
   * Decides what an inbound message may do, and records that this sender was
   * seen.
   *
   * An unknown sender gets a `pending` row with a fresh code — which is the
   * only thing that happens for them. Nothing is routed, no task appears, and
   * the owner sees a request they can accept or ignore.
   */
  resolve(input: {
    companyId: string;
    channelKind: string;
    chatId: string;
    senderId: string;
    displayName?: string;
    now?: number;
  }): PairingDecision {
    const now = input.now ?? Date.now();
    const existing = this.find(input.companyId, input.channelKind, input.senderId);

    if (!existing) {
      const created = this.createPending(input, now);
      return { allow: "none", pairing: created, reason: "unknown" };
    }

    this.db
      .prepare("UPDATE crew_messenger_pairings SET last_seen_at = ?, chat_id = ? WHERE id = ?")
      .run(now, input.chatId, existing.id);
    const pairing = this.get(existing.id)!;

    if (pairing.status === "blocked") return { allow: "none", pairing, reason: "blocked" };
    if (pairing.status === "pending") {
      // Refresh an expired code so a stranger who waited too long can try
      // again without an operator having to delete the row.
      if (pairing.code_expires_at !== null && pairing.code_expires_at <= now) {
        this.refreshCode(pairing.id, now);
      }
      return { allow: "none", pairing: this.get(pairing.id)!, reason: "pending" };
    }

    return pairing.role === "owner" ? { allow: "ceo", pairing } : { allow: "guest", pairing };
  }

  private createPending(
    input: { companyId: string; channelKind: string; chatId: string; senderId: string; displayName?: string },
    now: number,
  ): MessengerPairingRow {
    const id = newId("pair");
    this.db
      .prepare(
        `INSERT INTO crew_messenger_pairings
           (id, company_id, channel_kind, chat_id, sender_id, display_name, role, status,
            pairing_code, code_expires_at, last_seen_at)
         VALUES (?,?,?,?,?,?,'guest','pending',?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.channelKind,
        input.chatId,
        input.senderId,
        // The display name comes from the sender, so it is sanitised before
        // it is ever shown next to a decision the owner is about to make.
        sanitiseLine(input.displayName ?? "", 80),
        sixDigitCode(),
        now + PAIRING_CODE_TTL_MS,
        now,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: `${input.channelKind}:${input.senderId}`,
      action: "messenger.pairing_requested",
      entityType: "messenger_pairing",
      entityId: id,
      // The code is deliberately absent: an audit log that carries the code
      // hands it to anyone who can read the log.
      details: { channelKind: input.channelKind, senderId: input.senderId },
    });

    return this.get(id)!;
  }

  private refreshCode(id: string, now: number): void {
    this.db
      .prepare("UPDATE crew_messenger_pairings SET pairing_code = ?, code_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(sixDigitCode(), now + PAIRING_CODE_TTL_MS, now, id);
  }

  /**
   * The owner accepts a pending pairing, choosing what authority it carries.
   *
   * Granting `owner` is granting the ability to act as the CEO from a chat
   * app, so it is audited as its own thing rather than as a status change.
   */
  accept(
    id: string,
    role: PairingRole,
    opts: { actorType?: ActorType; actorId?: string; now?: number } = {},
  ): MessengerPairingRow | null {
    const pairing = this.get(id);
    if (!pairing) return null;
    if (pairing.status === "active") return pairing;
    if (pairing.status === "blocked") {
      throw new MessengerPairingError("This sender is blocked; unblock before pairing.");
    }

    const now = opts.now ?? Date.now();
    this.db
      .prepare(
        `UPDATE crew_messenger_pairings
            SET status = 'active', role = ?, pairing_code = '', code_expires_at = NULL,
                paired_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(role, now, now, id);

    appendAuditEvent(this.db, {
      companyId: pairing.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: role === "owner" ? "messenger.owner_granted" : "messenger.pairing_accepted",
      entityType: "messenger_pairing",
      entityId: id,
      details: {
        channelKind: pairing.channel_kind,
        senderId: pairing.sender_id,
        displayName: pairing.display_name,
        role,
      },
    });

    return this.get(id);
  }

  /** Refuses a sender, now and in future. Reversible via `accept` after unblock. */
  block(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): MessengerPairingRow | null {
    const pairing = this.get(id);
    if (!pairing) return null;

    this.db
      .prepare(
        `UPDATE crew_messenger_pairings
            SET status = 'blocked', role = 'guest', pairing_code = '', code_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: pairing.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "messenger.pairing_blocked",
      entityType: "messenger_pairing",
      entityId: id,
      details: { channelKind: pairing.channel_kind, senderId: pairing.sender_id },
    });
    return this.get(id);
  }

  /**
   * Takes a sender back to pending, revoking whatever authority they had.
   *
   * Kept distinct from `block`: revoking access from someone who should not
   * have had CEO authority is a different act than refusing a stranger, and
   * an operator reading the audit log should be able to tell them apart.
   */
  revoke(id: string, opts: { actorType?: ActorType; actorId?: string; now?: number } = {}): MessengerPairingRow | null {
    const pairing = this.get(id);
    if (!pairing) return null;

    const now = opts.now ?? Date.now();
    this.db
      .prepare(
        `UPDATE crew_messenger_pairings
            SET status = 'pending', role = 'guest', pairing_code = ?, code_expires_at = ?,
                paired_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(sixDigitCode(), now + PAIRING_CODE_TTL_MS, now, id);

    appendAuditEvent(this.db, {
      companyId: pairing.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "messenger.pairing_revoked",
      entityType: "messenger_pairing",
      entityId: id,
      details: { channelKind: pairing.channel_kind, senderId: pairing.sender_id, previousRole: pairing.role },
    });
    return this.get(id);
  }

  /** Unblocks without granting anything: back to pending, decide again. */
  unblock(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): MessengerPairingRow | null {
    const pairing = this.get(id);
    if (!pairing || pairing.status !== "blocked") return pairing;
    return this.revoke(id, opts);
  }
}
