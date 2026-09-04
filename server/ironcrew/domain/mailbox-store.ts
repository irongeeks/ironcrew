/**
 * IronCrew — mailbox repository.
 *
 * Holds connected mailboxes (IMAP, JMAP, Microsoft 365, Gmail), the n:n
 * grants that decide which agents may work which mailbox, and an index of
 * messages already seen (for de-duplication and triage provenance).
 *
 * Two structural guarantees, rather than conventions to remember:
 *
 * 1. `MailboxRow` does not contain the credentials column at all, and every
 *    query here names its columns explicitly instead of `SELECT *`. A
 *    mailbox row therefore cannot be serialised into an API response with
 *    its password attached, because the value is never in the object.
 *    Reaching credentials takes a deliberate `readCredentials()` call.
 * 2. Access is deny-by-default: an agent reaches a mailbox only if a row in
 *    `crew_mailbox_agents` says so. `access()` returns null when there is
 *    none — the same posture vendor policy and per-agent tool access take.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { defaultCredentialCipher, type CredentialCipher, type MailCredentials } from "../mail/mail-credentials.ts";

export const MAILBOX_KINDS = ["imap", "jmap", "m365", "gmail"] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

export function isMailboxKind(value: unknown): value is MailboxKind {
  return (MAILBOX_KINDS as readonly string[]).includes(value as string);
}

/** 'send' implies 'read'; there is no write-only access to a mailbox. */
export const MAILBOX_ACCESS_LEVELS = ["read", "send"] as const;
export type MailboxAccess = (typeof MAILBOX_ACCESS_LEVELS)[number];

/** Deliberately without `credentials_encrypted` — see this module's doc-comment. */
export interface MailboxRow {
  id: string;
  company_id: string;
  label: string;
  kind: MailboxKind;
  email_address: string;
  host: string;
  port: number;
  use_tls: number;
  username: string;
  smtp_host: string;
  smtp_port: number;
  session_url: string;
  tenant_id: string;
  client_id: string;
  poll_enabled: number;
  poll_interval_seconds: number;
  auto_triage: number;
  last_polled_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
}

const MAILBOX_COLUMNS = `id, company_id, label, kind, email_address, host, port, use_tls, username,
  smtp_host, smtp_port, session_url, tenant_id, client_id, poll_enabled, poll_interval_seconds,
  auto_triage, last_polled_at, last_error, created_at, updated_at`;

export interface MailboxAgentRow {
  agent_id: string;
  key: string;
  display_name: string;
  access: MailboxAccess;
  granted_at: number;
}

export interface MailboxMessageRow {
  id: string;
  mailbox_id: string;
  external_id: string;
  message_id: string;
  subject: string;
  from_address: string;
  received_at: number | null;
  task_id: string | null;
  triaged_at: number | null;
  created_at: number;
}

export interface CreateMailboxInput {
  companyId: string;
  label: string;
  kind: MailboxKind;
  emailAddress: string;
  host?: string;
  port?: number;
  useTls?: boolean;
  username?: string;
  smtpHost?: string;
  smtpPort?: number;
  sessionUrl?: string;
  tenantId?: string;
  clientId?: string;
  credentials?: MailCredentials;
  pollEnabled?: boolean;
  pollIntervalSeconds?: number;
  autoTriage?: boolean;
  actorType?: ActorType;
  actorId?: string;
}

export interface UpdateMailboxInput {
  label?: string;
  emailAddress?: string;
  host?: string;
  port?: number;
  useTls?: boolean;
  username?: string;
  smtpHost?: string;
  smtpPort?: number;
  sessionUrl?: string;
  tenantId?: string;
  clientId?: string;
  pollEnabled?: boolean;
  pollIntervalSeconds?: number;
  autoTriage?: boolean;
}

export class MailboxMutationError extends Error {}

export class MailboxStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: CredentialCipher = defaultCredentialCipher,
  ) {}

  /**
   * Per-kind required fields. Kept here rather than only in the API's Zod
   * schema, so a mailbox created through any path is equally complete.
   */
  private assertConnectable(input: {
    kind: MailboxKind;
    host?: string;
    username?: string;
    sessionUrl?: string;
    tenantId?: string;
    clientId?: string;
  }): void {
    const missing: string[] = [];
    if (input.kind === "imap") {
      if (!input.host?.trim()) missing.push("host");
      if (!input.username?.trim()) missing.push("username");
    }
    if (input.kind === "jmap" && !input.sessionUrl?.trim()) missing.push("sessionUrl");
    if (input.kind === "m365") {
      if (!input.tenantId?.trim()) missing.push("tenantId");
      if (!input.clientId?.trim()) missing.push("clientId");
    }
    if (input.kind === "gmail" && !input.clientId?.trim()) missing.push("clientId");
    if (missing.length > 0) {
      throw new MailboxMutationError(`A "${input.kind}" mailbox needs: ${missing.join(", ")}.`);
    }
  }

  private assertAgent(companyId: string, agentId: string): void {
    const agent = oneRow<{ company_id: string }>(
      this.db.prepare("SELECT company_id FROM crew_agents WHERE id = ?"),
      agentId,
    );
    if (!agent) throw new MailboxMutationError(`Agent "${agentId}" does not exist.`);
    if (agent.company_id !== companyId) {
      throw new MailboxMutationError("A mailbox can only be granted to an agent of the same company.");
    }
  }

  create(input: CreateMailboxInput): MailboxRow {
    if (!isMailboxKind(input.kind)) throw new MailboxMutationError(`Unknown mailbox kind "${input.kind}".`);
    if (!input.label.trim()) throw new MailboxMutationError("A mailbox needs a label.");
    if (!input.emailAddress.trim()) throw new MailboxMutationError("A mailbox needs an email address.");
    if (this.getByLabel(input.companyId, input.label)) {
      throw new MailboxMutationError(`A mailbox labelled "${input.label}" already exists for this company.`);
    }
    this.assertConnectable(input);

    const pollEnabled = input.pollEnabled ?? false;
    const autoTriage = input.autoTriage ?? false;
    // The schema also refuses this combination; failing here gives the
    // caller the reason instead of a raw CHECK-constraint error.
    if (autoTriage && !pollEnabled) {
      throw new MailboxMutationError("Auto-triage requires polling to be enabled for this mailbox.");
    }

    const id = newId("mbx");
    this.db
      .prepare(
        `INSERT INTO crew_mailboxes
           (id, company_id, label, kind, email_address, host, port, use_tls, username,
            smtp_host, smtp_port, session_url, tenant_id, client_id, credentials_encrypted,
            poll_enabled, poll_interval_seconds, auto_triage)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.label,
        input.kind,
        input.emailAddress,
        input.host ?? "",
        input.port ?? 0,
        input.useTls === false ? 0 : 1,
        input.username ?? "",
        input.smtpHost ?? "",
        input.smtpPort ?? 0,
        input.sessionUrl ?? "",
        input.tenantId ?? "",
        input.clientId ?? "",
        input.credentials ? this.cipher.encrypt(input.credentials) : "",
        pollEnabled ? 1 : 0,
        Math.max(30, input.pollIntervalSeconds ?? 300),
        autoTriage ? 1 : 0,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "mailbox.connected",
      entityType: "mailbox",
      entityId: id,
      // Metadata only — never the credentials this row also carries.
      details: { label: input.label, kind: input.kind, emailAddress: input.emailAddress, pollEnabled, autoTriage },
    });

    return this.get(id)!;
  }

  get(id: string): MailboxRow | null {
    return oneRow<MailboxRow>(this.db.prepare(`SELECT ${MAILBOX_COLUMNS} FROM crew_mailboxes WHERE id = ?`), id);
  }

  getByLabel(companyId: string, label: string): MailboxRow | null {
    return oneRow<MailboxRow>(
      this.db.prepare(`SELECT ${MAILBOX_COLUMNS} FROM crew_mailboxes WHERE company_id = ? AND label = ?`),
      companyId,
      label,
    );
  }

  list(companyId: string, opts: { kind?: MailboxKind } = {}): MailboxRow[] {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    return allRows<MailboxRow>(
      this.db.prepare(
        `SELECT ${MAILBOX_COLUMNS} FROM crew_mailboxes WHERE ${clauses.join(" AND ")} ORDER BY label ASC, rowid ASC`,
      ),
      ...params,
    );
  }

  /** Mailboxes due for a poll — poll_enabled and older than their own interval. */
  listPollable(companyId: string, now = Date.now()): MailboxRow[] {
    return this.list(companyId).filter(
      (m) =>
        m.poll_enabled === 1 && (m.last_polled_at === null || now - m.last_polled_at >= m.poll_interval_seconds * 1000),
    );
  }

  update(
    id: string,
    patch: UpdateMailboxInput,
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): MailboxRow | null {
    const mailbox = this.get(id);
    if (!mailbox) return null;

    if (patch.label !== undefined && patch.label !== mailbox.label) {
      if (!patch.label.trim()) throw new MailboxMutationError("A mailbox needs a label.");
      const clash = this.getByLabel(mailbox.company_id, patch.label);
      if (clash && clash.id !== id) {
        throw new MailboxMutationError(`A mailbox labelled "${patch.label}" already exists for this company.`);
      }
    }

    const pollEnabled = patch.pollEnabled ?? mailbox.poll_enabled === 1;
    const autoTriage = patch.autoTriage ?? mailbox.auto_triage === 1;
    if (autoTriage && !pollEnabled) {
      throw new MailboxMutationError("Auto-triage requires polling to be enabled for this mailbox.");
    }
    this.assertConnectable({
      kind: mailbox.kind,
      host: patch.host ?? mailbox.host,
      username: patch.username ?? mailbox.username,
      sessionUrl: patch.sessionUrl ?? mailbox.session_url,
      tenantId: patch.tenantId ?? mailbox.tenant_id,
      clientId: patch.clientId ?? mailbox.client_id,
    });

    this.db
      .prepare(
        `UPDATE crew_mailboxes
            SET label = COALESCE(?, label),
                email_address = COALESCE(?, email_address),
                host = COALESCE(?, host),
                port = COALESCE(?, port),
                use_tls = COALESCE(?, use_tls),
                username = COALESCE(?, username),
                smtp_host = COALESCE(?, smtp_host),
                smtp_port = COALESCE(?, smtp_port),
                session_url = COALESCE(?, session_url),
                tenant_id = COALESCE(?, tenant_id),
                client_id = COALESCE(?, client_id),
                poll_enabled = ?,
                poll_interval_seconds = COALESCE(?, poll_interval_seconds),
                auto_triage = ?,
                updated_at = unixepoch()*1000
          WHERE id = ?`,
      )
      .run(
        patch.label ?? null,
        patch.emailAddress ?? null,
        patch.host ?? null,
        patch.port ?? null,
        patch.useTls === undefined ? null : patch.useTls ? 1 : 0,
        patch.username ?? null,
        patch.smtpHost ?? null,
        patch.smtpPort ?? null,
        patch.sessionUrl ?? null,
        patch.tenantId ?? null,
        patch.clientId ?? null,
        pollEnabled ? 1 : 0,
        patch.pollIntervalSeconds === undefined ? null : Math.max(30, patch.pollIntervalSeconds),
        autoTriage ? 1 : 0,
        id,
      );

    appendAuditEvent(this.db, {
      companyId: mailbox.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "mailbox.updated",
      entityType: "mailbox",
      entityId: id,
      details: { label: patch.label ?? mailbox.label, pollEnabled, autoTriage },
    });
    return this.get(id);
  }

  /** Returns true when a row was deleted, false when it did not exist. */
  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const mailbox = this.get(id);
    if (!mailbox) return false;
    this.db.prepare("DELETE FROM crew_mailboxes WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: mailbox.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "mailbox.disconnected",
      entityType: "mailbox",
      entityId: id,
      details: { label: mailbox.label, kind: mailbox.kind },
    });
    return true;
  }

  // --- credentials --------------------------------------------------------
  // The only two methods that touch secret material. Neither is reachable
  // from a row object, so no caller can leak credentials by accident.

  readCredentials(id: string): MailCredentials {
    const row = oneRow<{ credentials_encrypted: string }>(
      this.db.prepare("SELECT credentials_encrypted FROM crew_mailboxes WHERE id = ?"),
      id,
    );
    if (!row) throw new MailboxMutationError(`Mailbox "${id}" does not exist.`);
    return this.cipher.decrypt(row.credentials_encrypted);
  }

  /**
   * Replaces the stored credentials. Used both by the owner (entering a
   * password) and by OAuth providers rotating a refreshed access token —
   * which is why it is deliberately not audited per call: a token refresh
   * is machinery, not a governance event, and would otherwise flood the
   * chain. Connecting and disconnecting a mailbox are audited.
   */
  writeCredentials(id: string, credentials: MailCredentials): void {
    const blob = this.cipher.encrypt(credentials);
    this.db
      .prepare("UPDATE crew_mailboxes SET credentials_encrypted = ?, updated_at = unixepoch()*1000 WHERE id = ?")
      .run(blob, id);
  }

  recordPollResult(id: string, result: { error?: string } = {}, now = Date.now()): void {
    this.db
      .prepare("UPDATE crew_mailboxes SET last_polled_at = ?, last_error = ? WHERE id = ?")
      .run(now, result.error ?? "", id);
  }

  // --- agent grants (the n:n relationship) --------------------------------

  grantAgent(
    mailboxId: string,
    agentId: string,
    access: MailboxAccess = "read",
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): MailboxAgentRow[] {
    const mailbox = this.get(mailboxId);
    if (!mailbox) throw new MailboxMutationError(`Mailbox "${mailboxId}" does not exist.`);
    if (!(MAILBOX_ACCESS_LEVELS as readonly string[]).includes(access)) {
      throw new MailboxMutationError(`Unknown mailbox access level "${access}".`);
    }
    this.assertAgent(mailbox.company_id, agentId);

    // Re-granting with a different level updates it rather than failing —
    // the owner's latest intent wins.
    this.db
      .prepare(
        `INSERT INTO crew_mailbox_agents (id, mailbox_id, agent_id, access) VALUES (?,?,?,?)
         ON CONFLICT (mailbox_id, agent_id) DO UPDATE SET access = excluded.access`,
      )
      .run(newId("mbxa"), mailboxId, agentId, access);

    appendAuditEvent(this.db, {
      companyId: mailbox.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "mailbox.agent_granted",
      entityType: "mailbox",
      entityId: mailboxId,
      details: { agentId, access, label: mailbox.label },
    });
    return this.agentsFor(mailboxId);
  }

  revokeAgent(mailboxId: string, agentId: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const mailbox = this.get(mailboxId);
    if (!mailbox) return false;
    const existing = this.access(mailboxId, agentId);
    if (!existing) return false;

    this.db.prepare("DELETE FROM crew_mailbox_agents WHERE mailbox_id = ? AND agent_id = ?").run(mailboxId, agentId);

    appendAuditEvent(this.db, {
      companyId: mailbox.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "mailbox.agent_revoked",
      entityType: "mailbox",
      entityId: mailboxId,
      details: { agentId, label: mailbox.label },
    });
    return true;
  }

  agentsFor(mailboxId: string): MailboxAgentRow[] {
    return allRows<MailboxAgentRow>(
      this.db.prepare(
        `SELECT a.id AS agent_id, a.key, a.display_name, ma.access, ma.granted_at
           FROM crew_mailbox_agents ma
           JOIN crew_agents a ON a.id = ma.agent_id
          WHERE ma.mailbox_id = ?
          ORDER BY a.display_name ASC`,
      ),
      mailboxId,
    );
  }

  /** The other direction of the same n:n: every mailbox this agent may work. */
  mailboxesForAgent(agentId: string): MailboxRow[] {
    return allRows<MailboxRow>(
      this.db.prepare(
        `SELECT ${MAILBOX_COLUMNS.split(",")
          .map((c) => `m.${c.trim()}`)
          .join(", ")}
           FROM crew_mailboxes m
           JOIN crew_mailbox_agents ma ON ma.mailbox_id = m.id
          WHERE ma.agent_id = ?
          ORDER BY m.label ASC`,
      ),
      agentId,
    );
  }

  /** Null means no access at all — the deny-by-default answer. */
  access(mailboxId: string, agentId: string): MailboxAccess | null {
    const row = oneRow<{ access: MailboxAccess }>(
      this.db.prepare("SELECT access FROM crew_mailbox_agents WHERE mailbox_id = ? AND agent_id = ?"),
      mailboxId,
      agentId,
    );
    return row?.access ?? null;
  }

  // --- seen-message index -------------------------------------------------

  /**
   * Records a message as seen. Returns `{ row, isNew }` so a poll can tell
   * genuinely new mail from mail it has already handled without a second
   * query — the de-duplication the whole polling path depends on.
   */
  recordSeenMessage(input: {
    mailboxId: string;
    externalId: string;
    messageId?: string;
    subject?: string;
    fromAddress?: string;
    receivedAt?: number | null;
  }): { row: MailboxMessageRow; isNew: boolean } {
    const existing = this.findMessage(input.mailboxId, input.externalId);
    if (existing) return { row: existing, isNew: false };

    const id = newId("mmsg");
    this.db
      .prepare(
        `INSERT INTO crew_mailbox_messages
           (id, mailbox_id, external_id, message_id, subject, from_address, received_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.mailboxId,
        input.externalId,
        input.messageId ?? "",
        input.subject ?? "",
        input.fromAddress ?? "",
        input.receivedAt ?? null,
      );
    return { row: this.findMessage(input.mailboxId, input.externalId)!, isNew: true };
  }

  findMessage(mailboxId: string, externalId: string): MailboxMessageRow | null {
    return oneRow<MailboxMessageRow>(
      this.db.prepare("SELECT * FROM crew_mailbox_messages WHERE mailbox_id = ? AND external_id = ?"),
      mailboxId,
      externalId,
    );
  }

  messages(mailboxId: string, limit = 100): MailboxMessageRow[] {
    return allRows<MailboxMessageRow>(
      this.db.prepare(
        "SELECT * FROM crew_mailbox_messages WHERE mailbox_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?",
      ),
      mailboxId,
      Math.min(Math.max(limit, 1), 500),
    );
  }

  linkMessageToTask(messageId: string, taskId: string, now = Date.now()): MailboxMessageRow | null {
    this.db
      .prepare("UPDATE crew_mailbox_messages SET task_id = ?, triaged_at = ? WHERE id = ?")
      .run(taskId, now, messageId);
    return oneRow<MailboxMessageRow>(this.db.prepare("SELECT * FROM crew_mailbox_messages WHERE id = ?"), messageId);
  }
}
