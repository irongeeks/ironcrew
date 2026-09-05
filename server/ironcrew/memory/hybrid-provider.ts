import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { allRows, oneRow } from "../domain/sql.ts";
import { redactText } from "../security/redaction.ts";
import type { MemoryProvider, MemoryWriteInput, MemoryWriteResult, MemorySearchHit } from "./memory-provider.ts";
import type { HonchoMemoryProvider } from "./honcho-provider.ts";
import { readCurrentProvenance } from "./current-provenance.ts";

const metadataSchema = z.object({
  kind: z.enum(["note", "fact", "preference", "hypothesis", "summary"]),
  title: z.string(),
  provenance: z.object({
    companyId: z.string(),
    taskId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    source: z.string().optional(),
    confidence: z.number().optional(),
    sensitivity: z.string().optional(),
  }),
});
interface SyncRow {
  external_id: string;
  metadata_json: string;
  operation: "write" | "delete";
  state: string;
  attempts: number;
  revision: number;
  not_before: number;
}
export interface HybridOptions {
  db: DatabaseSync;
  local: MemoryProvider;
  semantic: HonchoMemoryProvider;
  now?: () => number;
}
/** The local provider is authoritative. An outbox contains locators and provenance,
 * never note bodies or credentials. The application scheduler drives bounded retries.
 */
export class HybridMemoryProvider implements MemoryProvider {
  readonly kind: string;
  private readonly now: () => number;
  private readonly db: DatabaseSync;
  private readonly companyId: string;
  private syncing = false;
  constructor(private readonly options: HybridOptions) {
    this.kind = options.local.kind; // Existing stored Obsidian references remain valid.
    this.db = options.db;
    this.companyId = options.semantic.companyId;
    this.now = options.now ?? Date.now;
  }
  async write(entry: MemoryWriteInput): Promise<MemoryWriteResult> {
    if (entry.provenance && entry.provenance.companyId !== this.companyId)
      throw new Error("Memory company scope mismatch.");
    const cleaned = {
      ...entry,
      title: redactText(entry.title),
      content: redactText(entry.content),
      tags: entry.tags?.map((tag) => redactText(tag)),
      provenance: entry.provenance
        ? { ...entry.provenance, source: redactText(entry.provenance.source ?? "") }
        : undefined,
    };
    const result = await this.options.local.write(cleaned);
    if (this.options.semantic.accepts(entry.provenance)) {
      // Failure to persist the outbox must surface, never claim a successful sync.
      this.db
        .prepare(
          `INSERT INTO crew_memory_sync(company_id,external_id,metadata_json,operation)
        VALUES(?,?,?,'write')`,
        )
        .run(
          this.companyId,
          result.externalId,
          JSON.stringify({
            kind: entry.kind,
            title: cleaned.title,
            provenance: { ...entry.provenance, source: redactText(entry.provenance?.source ?? "") },
          }),
        );
    }
    return result;
  }
  private row(externalId: string): SyncRow | null {
    return oneRow<SyncRow>(
      this.db.prepare("SELECT * FROM crew_memory_sync WHERE company_id=? AND external_id=?"),
      this.companyId,
      externalId,
    );
  }
  async read(externalId: string): Promise<string | null> {
    if (this.row(externalId)?.operation === "delete") return null;
    return this.options.local.read(externalId);
  }
  async delete(externalId: string): Promise<void> {
    // Persist a deletion tombstone before changing local state. An in-flight upload
    // may finish, but cannot overwrite this operation; its next retry removes it.
    this.db
      .prepare(
        `UPDATE crew_memory_sync SET operation='delete',state='queued',attempts=0,last_error=NULL
      WHERE company_id=? AND external_id=?`,
      )
      .run(this.companyId, externalId);
    await this.options.local.delete(externalId);
  }
  async search(query: string, limit = 20): Promise<MemorySearchHit[]> {
    const bounded = Math.max(1, Math.min(50, limit));
    const local = await this.options.local.search(query, bounded);
    // Search text has no sensitivity label; never transmit caller text implicitly.
    // Explicit searchSemantic is used by the authenticated opt-in search API only.
    return local.filter((hit) => this.row(hit.externalId)?.operation !== "delete").slice(0, bounded);
  }
  async searchSemantic(query: string, sensitivity: string, limit = 20): Promise<MemorySearchHit[]> {
    const local = await this.search(query, limit);
    if (!this.options.semantic.accepts({ companyId: this.companyId, sensitivity })) return local;
    try {
      const remote = await this.options.semantic.search(query, limit);
      const seen = new Set(local.map((hit) => hit.externalId));
      for (const hit of remote) {
        const row = this.row(hit.externalId);
        if (!row || row.operation === "delete" || row.state !== "synced" || seen.has(hit.externalId)) continue;
        // An external edit can revoke permission before the watcher or outbox runs.
        const content = await this.options.local.read(hit.externalId);
        if (content === null || !this.maySyncCurrent(content, metadataSchema.parse(JSON.parse(row.metadata_json))))
          continue;
        local.push(hit);
        seen.add(hit.externalId);
      }
    } catch {
      /* Local results remain available; syncStatus and health expose remote state. */
    }
    return local.slice(0, Math.max(1, Math.min(50, limit)));
  }
  /** File watcher notifications only requeue already-classified references. New or
   * untracked Markdown is never automatically granted external-sync permission. */
  localChanged(externalId: string): void {
    this.db
      .prepare(
        `UPDATE crew_memory_sync SET not_before=CASE state WHEN 'synced' THEN 0 ELSE not_before END,
        state='queued',revision=revision+1
      WHERE company_id=? AND external_id=? AND operation='write'`,
      )
      .run(this.companyId, externalId);
  }

  /** The original explicit grant applies only while the authoritative file keeps
   * its company, scope and classification. Removing or damaging metadata cannot
   * turn old outbox metadata into permission to transmit new document contents. */
  private maySyncCurrent(content: string, metadata: z.infer<typeof metadataSchema>): boolean {
    const current = readCurrentProvenance(content);
    const granted = metadata.provenance;
    return Boolean(
      current &&
      this.options.semantic.accepts(granted) &&
      this.options.semantic.accepts(current) &&
      current.sensitivity === granted.sensitivity &&
      (["taskId", "projectId", "agentId"] as const).every((key) => (current[key] ?? null) === (granted[key] ?? null)),
    );
  }

  syncStatus(): { pending: number; failed: number; synced: number; pendingDeletion: number } {
    const rows = allRows<{ state: string; operation: string; count: number }>(
      this.db.prepare(`SELECT state,operation,count(*) AS count
      FROM crew_memory_sync WHERE company_id=? GROUP BY state,operation`),
      this.companyId,
    );
    return rows.reduce(
      (status, row) => {
        if (row.operation === "delete") status.pendingDeletion += row.count;
        if (row.state === "synced") status.synced += row.count;
        else status.pending += row.count;
        if (row.state === "failed") status.failed += row.count;
        return status;
      },
      { pending: 0, failed: 0, synced: 0, pendingDeletion: 0 },
    );
  }
  async syncPending(limit = 10): Promise<void> {
    if (this.syncing || !this.options.semantic.config.enabled) return;
    this.syncing = true;
    try {
      const rows = allRows<SyncRow>(
        this.db.prepare(`SELECT * FROM crew_memory_sync WHERE company_id=?
        AND state != 'synced' AND not_before <= ? ORDER BY CASE operation WHEN 'delete' THEN 0 ELSE 1 END, not_before LIMIT ?`),
        this.companyId,
        this.now(),
        Math.max(1, Math.min(25, limit)),
      );
      for (const row of rows) {
        // Claim through an atomic compare-and-swap, shared by multiple schedulers.
        const claimed = this.db
          .prepare(
            `UPDATE crew_memory_sync SET not_before=? WHERE company_id=? AND external_id=?
          AND not_before=? AND operation=? AND state!='synced'`,
          )
          .run(this.now() + 180000, this.companyId, row.external_id, row.not_before, row.operation);
        if (!claimed.changes) continue;
        try {
          if (row.operation === "delete") {
            await this.options.semantic.delete(row.external_id);
            await this.options.local.delete(row.external_id);
            this.db
              .prepare("DELETE FROM crew_memory_sync WHERE company_id=? AND external_id=? AND operation='delete'")
              .run(this.companyId, row.external_id);
          } else {
            const content = await this.options.local.read(row.external_id);
            if (content === null) {
              await this.options.semantic.delete(row.external_id);
              this.db
                .prepare("DELETE FROM crew_memory_sync WHERE company_id=? AND external_id=? AND operation='write'")
                .run(this.companyId, row.external_id);
              continue;
            }
            const metadata = metadataSchema.parse(JSON.parse(row.metadata_json));
            if (!this.maySyncCurrent(content, metadata)) {
              await this.options.semantic.delete(row.external_id);
              this.db
                .prepare("DELETE FROM crew_memory_sync WHERE company_id=? AND external_id=? AND operation='write'")
                .run(this.companyId, row.external_id);
              continue;
            }
            await this.options.semantic.upsert(row.external_id, { ...metadata, content });
            this.db
              .prepare(
                `UPDATE crew_memory_sync SET state='synced',last_error=NULL,not_before=0 WHERE company_id=? AND external_id=? AND operation='write' AND revision=?`,
              )
              .run(this.companyId, row.external_id, row.revision);
          }
        } catch {
          // Never persist raw transport errors. Retry forever with bounded backoff;
          // deletion failures must remain visible and retryable across restarts.
          const delay = Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7));
          this.db
            .prepare(
              `UPDATE crew_memory_sync SET state='failed',attempts=attempts+1,not_before=?,last_error='Semantic memory synchronization failed'
            WHERE company_id=? AND external_id=? AND operation=?`,
            )
            .run(this.now() + delay, this.companyId, row.external_id, row.operation);
        }
      }
    } finally {
      this.syncing = false;
    }
  }
  async testConnection() {
    const local = await this.options.local.testConnection();
    if (!local.ok) return local;
    const remote = await this.options.semantic.testConnection();
    return {
      ok: true,
      message: remote.ok
        ? "Obsidian und Honcho erreichbar."
        : "Obsidian verfügbar; Honcho offline. Synchronisierung bleibt gespeichert.",
    };
  }
  /** Export caller-authorized locators; the operational DB supplies provenance. */
  async exportEntries(externalIds: readonly string[]): Promise<Array<{ externalId: string; content: string }>> {
    if (externalIds.length > 1000) throw new Error("Memory export exceeds 1000 entries.");
    const result: Array<{ externalId: string; content: string }> = [];
    let bytes = 0;
    for (const externalId of externalIds) {
      const content = await this.read(externalId);
      if (content === null) continue;
      bytes += Buffer.byteLength(content);
      if (bytes > 10 * 1024 * 1024) throw new Error("Memory export exceeds 10 MiB.");
      result.push({ externalId, content });
    }
    return result;
  }
}
