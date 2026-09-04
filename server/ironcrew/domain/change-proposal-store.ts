/**
 * IronCrew — proposing file changes, and applying them only once approved.
 *
 * The middle state that was missing: an agent produces the exact content it
 * wants written, the owner sees paths and contents, and nothing reaches the
 * disk until the proposal's `ApprovalRequest` is approved.
 *
 * Four rules hold, and each exists because its absence has an obvious failure:
 *
 * 1. **No approval, no apply.** `apply()` refuses unless the proposal is
 *    `approved`. There is no force flag, because a force flag is how the gate
 *    stops being a gate.
 *
 * 2. **The world must not have moved.** Every file carries the hash it had
 *    when proposed. If it differs at apply time, the apply is refused — an
 *    approval granted against one state of the world does not describe what
 *    would happen in another, so it has stopped being an approval.
 *
 * 3. **Nothing leaves the workspace.** Every path is resolved and re-tested
 *    for containment at apply time, not just at proposal time: `..`, absolute
 *    paths and symlink escapes are all the same failure.
 *
 * 4. **All or nothing.** Files are validated first, written second. A
 *    proposal that would half-apply is refused before the first write, so a
 *    rejected apply leaves the workspace exactly as it was.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export const CHANGE_OPERATIONS = ["create", "update", "delete"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

export const CHANGE_PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied", "failed", "superseded"] as const;
export type ChangeProposalStatus = (typeof CHANGE_PROPOSAL_STATUSES)[number];

export interface ChangeProposalRow {
  id: string;
  company_id: string;
  task_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  title: string;
  summary: string;
  workspace_path: string;
  approval_id: string | null;
  status: ChangeProposalStatus;
  applied_at: number | null;
  applied_by: string;
  apply_error: string;
  created_at: number;
  updated_at: number;
}

export interface ChangeProposalFileRow {
  id: string;
  proposal_id: string;
  path: string;
  operation: ChangeOperation;
  content: string;
  expected_sha256: string;
  applied_sha256: string;
}

const PROPOSAL_COLUMNS = `id, company_id, task_id, run_id, agent_id, title, summary, workspace_path,
  approval_id, status, applied_at, applied_by, apply_error, created_at, updated_at`;
const FILE_COLUMNS = `id, proposal_id, path, operation, content, expected_sha256, applied_sha256`;

export class ChangeProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeProposalError";
  }
}

/** A file that could not be applied, and why. */
export interface ApplyConflict {
  path: string;
  reason: string;
}

export interface ApplyResult {
  proposal: ChangeProposalRow;
  applied: string[];
  conflicts: ApplyConflict[];
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface ProposedFile {
  path: string;
  operation: ChangeOperation;
  /** Required for create and update; ignored for delete. */
  content?: string;
  /**
   * The file's hash when proposed. Omitted, it is read from disk now — which
   * is right when the agent has just looked at the file, and wrong if a long
   * time has passed since. A caller that knows what it read should say so.
   */
  expectedSha256?: string;
}

export class ChangeProposalStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Resolves a proposed path against the workspace root, refusing anything
   * that escapes it.
   *
   * `realpath` on the containing directory is what catches a symlink pointing
   * out of the tree — a check on the string alone would not.
   */
  private resolveInside(workspacePath: string, relative: string): string {
    if (path.isAbsolute(relative)) {
      throw new ChangeProposalError(`"${relative}" is absolute; paths are relative to the workspace.`);
    }
    const root = path.resolve(workspacePath);
    const target = path.resolve(root, relative);

    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new ChangeProposalError(`"${relative}" resolves outside the workspace.`);
    }

    // A symlinked parent would pass the string test above and still write
    // outside the tree, so the real directory is checked when it exists.
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new ChangeProposalError(`"${relative}" resolves outside the workspace through a link.`);
      }
    }
    return target;
  }

  /** Hash of a file's current content, or '' when it does not exist. */
  private currentHash(absolute: string): string {
    if (!fs.existsSync(absolute)) return "";
    return sha256(fs.readFileSync(absolute, "utf-8"));
  }

  create(
    input: {
      companyId: string;
      title: string;
      workspacePath: string;
      files: ProposedFile[];
      summary?: string;
      taskId?: string | null;
      runId?: string | null;
      agentId?: string | null;
      approvalId?: string | null;
    } & { actorType?: ActorType; actorId?: string },
  ): ChangeProposalRow {
    if (!input.title.trim()) throw new ChangeProposalError("A change proposal needs a title.");
    if (input.files.length === 0) throw new ChangeProposalError("A change proposal needs at least one file.");

    // Validate every path before writing any row, so a rejected proposal
    // leaves nothing behind.
    const seen = new Set<string>();
    for (const file of input.files) {
      if (!file.path.trim()) throw new ChangeProposalError("A proposed file needs a path.");
      if (seen.has(file.path)) throw new ChangeProposalError(`"${file.path}" is proposed twice.`);
      seen.add(file.path);
      this.resolveInside(input.workspacePath, file.path);
      if (file.operation !== "delete" && file.content === undefined) {
        throw new ChangeProposalError(`"${file.path}" is a ${file.operation} but carries no content.`);
      }
    }

    const id = newId("chg");
    this.db
      .prepare(
        `INSERT INTO crew_change_proposals
           (id, company_id, task_id, run_id, agent_id, title, summary, workspace_path, approval_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.taskId ?? null,
        input.runId ?? null,
        input.agentId ?? null,
        input.title.trim(),
        input.summary ?? "",
        input.workspacePath,
        input.approvalId ?? null,
      );

    const insertFile = this.db.prepare(
      `INSERT INTO crew_change_proposal_files
         (id, proposal_id, path, operation, content, expected_sha256)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const file of input.files) {
      const absolute = this.resolveInside(input.workspacePath, file.path);
      insertFile.run(
        newId("chgf"),
        id,
        file.path,
        file.operation,
        file.operation === "delete" ? "" : (file.content ?? ""),
        file.expectedSha256 ?? this.currentHash(absolute),
      );
    }

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? input.agentId ?? "agent",
      action: "change_proposal.created",
      entityType: "change_proposal",
      entityId: id,
      taskId: input.taskId ?? undefined,
      // Paths and counts, never file contents: an audit log is not a place to
      // duplicate a repository.
      details: { title: input.title.trim(), files: input.files.map((f) => `${f.operation}:${f.path}`) },
    });

    return this.get(id)!;
  }

  get(id: string): ChangeProposalRow | null {
    return oneRow<ChangeProposalRow>(
      this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM crew_change_proposals WHERE id = ?`),
      id,
    );
  }

  files(proposalId: string): ChangeProposalFileRow[] {
    return allRows<ChangeProposalFileRow>(
      this.db.prepare(`SELECT ${FILE_COLUMNS} FROM crew_change_proposal_files WHERE proposal_id = ? ORDER BY path`),
      proposalId,
    );
  }

  list(companyId: string, opts: { status?: ChangeProposalStatus; limit?: number } = {}): ChangeProposalRow[] {
    if (opts.status) {
      return allRows<ChangeProposalRow>(
        this.db.prepare(
          `SELECT ${PROPOSAL_COLUMNS} FROM crew_change_proposals
            WHERE company_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
        ),
        companyId,
        opts.status,
        opts.limit ?? 50,
      );
    }
    return allRows<ChangeProposalRow>(
      this.db.prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM crew_change_proposals
          WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`,
      ),
      companyId,
      opts.limit ?? 50,
    );
  }

  /** Records the owner's decision. Only a pending proposal can be decided. */
  decide(
    id: string,
    decision: "approved" | "rejected",
    opts: { actorType?: ActorType; actorId?: string; reason?: string } = {},
  ): ChangeProposalRow | null {
    const proposal = this.get(id);
    if (!proposal) return null;
    if (proposal.status !== "pending") {
      throw new ChangeProposalError(`Proposal "${id}" is ${proposal.status}, not pending.`);
    }

    this.db
      .prepare("UPDATE crew_change_proposals SET status = ?, updated_at = ? WHERE id = ?")
      .run(decision, Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: proposal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: `change_proposal.${decision}`,
      entityType: "change_proposal",
      entityId: id,
      details: { title: proposal.title, reason: opts.reason ?? "" },
    });

    return this.get(id);
  }

  /**
   * Writes an approved proposal to disk.
   *
   * Validation runs over every file first; only if all pass does anything get
   * written. A proposal that would half-apply is refused before the first
   * write, so a failure leaves the workspace as it was.
   */
  apply(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): ApplyResult {
    const proposal = this.get(id);
    if (!proposal) throw new ChangeProposalError(`Proposal "${id}" does not exist.`);

    // Idempotent: applying twice is a no-op, not a second write.
    if (proposal.status === "applied") {
      return { proposal, applied: [], conflicts: [] };
    }
    if (proposal.status !== "approved") {
      throw new ChangeProposalError(
        `Proposal "${id}" is ${proposal.status}. Only an approved proposal can be applied.`,
      );
    }

    const files = this.files(id);
    const conflicts: ApplyConflict[] = [];
    const planned: Array<{ file: ChangeProposalFileRow; absolute: string }> = [];

    for (const file of files) {
      let absolute: string;
      try {
        absolute = this.resolveInside(proposal.workspace_path, file.path);
      } catch (err) {
        conflicts.push({ path: file.path, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const current = this.currentHash(absolute);

      if (file.operation === "create") {
        // "Create" that quietly overwrites is a different act than the one
        // that was approved.
        if (current !== "") {
          conflicts.push({ path: file.path, reason: "Datei existiert bereits; angelegt werden sollte sie neu." });
          continue;
        }
      } else if (current === "") {
        conflicts.push({ path: file.path, reason: "Datei existiert nicht mehr." });
        continue;
      } else if (file.expected_sha256 !== "" && current !== file.expected_sha256) {
        // The world moved. The approval described a change against a state
        // that no longer holds, so it no longer describes what would happen.
        conflicts.push({
          path: file.path,
          reason: "Datei wurde seit dem Vorschlag geändert; die Freigabe gilt nicht mehr für diesen Stand.",
        });
        continue;
      }

      planned.push({ file, absolute });
    }

    if (conflicts.length > 0) {
      const summary = conflicts.map((c) => `${c.path}: ${c.reason}`).join("; ");
      this.db
        .prepare("UPDATE crew_change_proposals SET status = 'failed', apply_error = ?, updated_at = ? WHERE id = ?")
        .run(summary, Date.now(), id);

      appendAuditEvent(this.db, {
        companyId: proposal.company_id,
        actorType: opts.actorType ?? "owner",
        actorId: opts.actorId ?? "ceo",
        action: "change_proposal.apply_failed",
        entityType: "change_proposal",
        entityId: id,
        outcome: "failed",
        details: { conflicts: conflicts.map((c) => c.path), reason: summary },
      });

      return { proposal: this.get(id)!, applied: [], conflicts };
    }

    const applied: string[] = [];
    const recordHash = this.db.prepare("UPDATE crew_change_proposal_files SET applied_sha256 = ? WHERE id = ?");

    for (const { file, absolute } of planned) {
      if (file.operation === "delete") {
        fs.rmSync(absolute, { force: true });
        recordHash.run("", file.id);
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, file.content, "utf-8");
        recordHash.run(sha256(file.content), file.id);
      }
      applied.push(file.path);
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE crew_change_proposals
            SET status = 'applied', applied_at = ?, applied_by = ?, apply_error = '', updated_at = ?
          WHERE id = ?`,
      )
      .run(now, opts.actorId ?? "ceo", now, id);

    appendAuditEvent(this.db, {
      companyId: proposal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "change_proposal.applied",
      entityType: "change_proposal",
      entityId: id,
      details: { title: proposal.title, files: applied },
    });

    return { proposal: this.get(id)!, applied, conflicts: [] };
  }

  /**
   * Marks a proposal as overtaken by a newer one for the same work.
   *
   * Kept rather than deleted: what was proposed and why it was dropped is
   * part of the record.
   */
  supersede(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): ChangeProposalRow | null {
    const proposal = this.get(id);
    if (!proposal) return null;
    if (proposal.status === "applied") {
      throw new ChangeProposalError("An applied proposal cannot be superseded; it already happened.");
    }

    this.db
      .prepare("UPDATE crew_change_proposals SET status = 'superseded', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: proposal.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "change_proposal.superseded",
      entityType: "change_proposal",
      entityId: id,
      details: { title: proposal.title },
    });
    return this.get(id);
  }
}
