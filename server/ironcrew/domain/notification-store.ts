/**
 * IronCrew — notification repository (the decision inbox's feed).
 *
 * A notification is a pointer to something that already happened and is
 * already audited elsewhere (an approval was requested, a milestone was
 * missed) — it exists so the CEO has one place to see what needs attention,
 * not to be a second source of truth. That is also why creating or reading
 * one is not itself an audit event: the governance-relevant action (e.g.
 * `approval.requested`) is already in the hash chain from the store that
 * actually did it.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationRow {
  id: string;
  company_id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  task_id: string | null;
  approval_id: string | null;
  read_at: number | null;
  created_at: number;
}

export interface CreateNotificationInput {
  companyId: string;
  kind: string;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  taskId?: string | null;
  approvalId?: string | null;
}

export class NotificationStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateNotificationInput): NotificationRow {
    const id = newId("ntf");
    this.db
      .prepare(
        `INSERT INTO crew_notifications (id, company_id, kind, severity, title, body, task_id, approval_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.kind,
        input.severity ?? "info",
        input.title,
        input.body ?? "",
        input.taskId ?? null,
        input.approvalId ?? null,
      );
    return this.get(id)!;
  }

  get(id: string): NotificationRow | null {
    return oneRow<NotificationRow>(this.db.prepare("SELECT * FROM crew_notifications WHERE id = ?"), id);
  }

  list(companyId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): NotificationRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.unreadOnly) clauses.push("read_at IS NULL");
    params.push(limit);
    // created_at has whole-second resolution (unixepoch()*1000), so two rows
    // inserted within the same second tie on it — rowid (SQLite's implicit,
    // monotonically-increasing insert order) breaks the tie deterministically.
    return allRows<NotificationRow>(
      this.db.prepare(
        `SELECT * FROM crew_notifications WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ),
      ...params,
    );
  }

  countUnread(companyId: string): number {
    const row = oneRow<{ n: number }>(
      this.db.prepare("SELECT COUNT(*) AS n FROM crew_notifications WHERE company_id = ? AND read_at IS NULL"),
      companyId,
    );
    return row?.n ?? 0;
  }

  /** Idempotent: reading an already-read (or missing) notification is a no-op. */
  markRead(id: string, now = Date.now()): NotificationRow | null {
    this.db.prepare("UPDATE crew_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(now, id);
    return this.get(id);
  }

  /** Used when an approval is decided, so its notification clears with it. */
  markReadByApproval(companyId: string, approvalId: string, now = Date.now()): void {
    this.db
      .prepare("UPDATE crew_notifications SET read_at = COALESCE(read_at, ?) WHERE company_id = ? AND approval_id = ?")
      .run(now, companyId, approvalId);
  }
}
