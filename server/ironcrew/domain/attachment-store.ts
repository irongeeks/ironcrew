/**
 * IronCrew — attachment repository.
 *
 * Row metadata only (filename, content type, size, a checksum, and where
 * the blob lives) — the byte content itself is written/read through
 * attachment-storage.ts, kept out of this store so it stays testable
 * headlessly like every other domain store here. An attachment is scoped by
 * exactly one of `task_id` / `project_id`, or neither for the general,
 * company-wide document store — see the migration's own comment.
 *
 * The filename is the one attacker-supplied field here, and it is displayed
 * in lists beside other filenames. A right-to-left override turns
 * `invoice\u202Efdp.exe` into something that reads as `invoice.pdf`, so names
 * are sanitised on the way in (see policy/untrusted-content.ts) rather than
 * every place they are rendered.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { sanitiseLine } from "../policy/untrusted-content.ts";

export interface AttachmentRow {
  id: string;
  company_id: string;
  task_id: string | null;
  project_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

export interface CreateAttachmentInput {
  companyId: string;
  taskId?: string | null;
  projectId?: string | null;
  filename: string;
  contentType?: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
  uploadedBy?: string;
  actorType?: ActorType;
  actorId?: string;
}

export class AttachmentMutationError extends Error {}

export class AttachmentStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateAttachmentInput): AttachmentRow {
    if (input.taskId && input.projectId) {
      throw new AttachmentMutationError("An attachment may be scoped to a task or a project, not both.");
    }
    const filename = sanitiseLine(input.filename, 255);
    if (!filename) throw new AttachmentMutationError("An attachment needs a filename.");
    if (input.sizeBytes < 0) throw new AttachmentMutationError("sizeBytes must not be negative.");

    if (input.taskId) {
      const task = oneRow<{ company_id: string }>(
        this.db.prepare("SELECT company_id FROM crew_tasks WHERE id = ?"),
        input.taskId,
      );
      if (!task) throw new AttachmentMutationError(`Task "${input.taskId}" does not exist.`);
      if (task.company_id !== input.companyId) {
        throw new AttachmentMutationError("An attachment's task must belong to the same company.");
      }
    }
    if (input.projectId) {
      const project = oneRow<{ company_id: string }>(
        this.db.prepare("SELECT company_id FROM crew_projects WHERE id = ?"),
        input.projectId,
      );
      if (!project) throw new AttachmentMutationError(`Project "${input.projectId}" does not exist.`);
      if (project.company_id !== input.companyId) {
        throw new AttachmentMutationError("An attachment's project must belong to the same company.");
      }
    }

    const id = newId("att");
    this.db
      .prepare(
        `INSERT INTO crew_attachments
           (id, company_id, task_id, project_id, filename, content_type, size_bytes, storage_key, sha256, uploaded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.taskId ?? null,
        input.projectId ?? null,
        filename,
        input.contentType ?? "application/octet-stream",
        input.sizeBytes,
        input.storageKey,
        input.sha256,
        input.uploadedBy ?? "ceo",
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "attachment.uploaded",
      entityType: "attachment",
      entityId: id,
      taskId: input.taskId ?? null,
      details: {
        filename,
        sizeBytes: input.sizeBytes,
        scope: input.taskId ? "task" : input.projectId ? "project" : "general",
      },
    });

    return this.get(id)!;
  }

  get(id: string): AttachmentRow | null {
    return oneRow<AttachmentRow>(this.db.prepare("SELECT * FROM crew_attachments WHERE id = ?"), id);
  }

  listForTask(companyId: string, taskId: string): AttachmentRow[] {
    return allRows<AttachmentRow>(
      this.db.prepare(
        "SELECT * FROM crew_attachments WHERE company_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      companyId,
      taskId,
    );
  }

  listForProject(companyId: string, projectId: string): AttachmentRow[] {
    return allRows<AttachmentRow>(
      this.db.prepare(
        "SELECT * FROM crew_attachments WHERE company_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC",
      ),
      companyId,
      projectId,
    );
  }

  /** The general, company-wide document store: attachments scoped to neither a task nor a project. */
  listGeneral(companyId: string): AttachmentRow[] {
    return allRows<AttachmentRow>(
      this.db.prepare(
        `SELECT * FROM crew_attachments
         WHERE company_id = ? AND task_id IS NULL AND project_id IS NULL
         ORDER BY created_at DESC, rowid DESC`,
      ),
      companyId,
    );
  }

  /**
   * Deletes the row and returns it (or null if it did not exist). Does not
   * touch the blob on disk — the caller (CompanyOrchestrator.deleteAttachment)
   * decides that using isStorageKeyOrphaned(), since the same content-
   * addressed storage_key can be shared by more than one row.
   */
  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): AttachmentRow | null {
    const attachment = this.get(id);
    if (!attachment) return null;
    this.db.prepare("DELETE FROM crew_attachments WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: attachment.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "attachment.deleted",
      entityType: "attachment",
      entityId: id,
      taskId: attachment.task_id,
      details: { filename: attachment.filename },
    });
    return attachment;
  }

  /** True when no row (in any company — storage_key is already company-prefixed, see attachment-storage.ts) still references this blob. */
  isStorageKeyOrphaned(storageKey: string): boolean {
    const row = oneRow<{ n: number }>(
      this.db.prepare("SELECT COUNT(*) AS n FROM crew_attachments WHERE storage_key = ?"),
      storageKey,
    );
    return (row?.n ?? 0) === 0;
  }
}
