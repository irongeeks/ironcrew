/**
 * IronCrew — memory reference repository.
 *
 * Stores WHERE a memory entry lives (provider + external locator) plus its
 * IronCrew-side provenance (task/project/agent, kind, confidence,
 * sensitivity) — never the entry's own content, which the provider itself
 * owns (obsidian-provider.ts). Same division of responsibility as
 * SecretRef/SecretStore: recording a memory is audited, but the audit
 * details only ever carry metadata (title, kind, provider), matching
 * appendAuditEvent's own "never log a value" discipline.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { isMemoryKind, type MemoryKind } from "../memory/memory-provider.ts";

export interface MemoryRefRow {
  id: string;
  company_id: string;
  provider: string;
  external_id: string;
  kind: MemoryKind;
  title: string;
  path: string | null;
  task_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  source: string;
  confidence: number;
  sensitivity: string;
  created_at: number;
}

export interface CreateMemoryRefInput {
  companyId: string;
  provider: string;
  externalId: string;
  kind: MemoryKind;
  title: string;
  path?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  source?: string;
  confidence?: number;
  sensitivity?: string;
  actorType?: ActorType;
  actorId?: string;
}

export class MemoryMutationError extends Error {}

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateMemoryRefInput): MemoryRefRow {
    if (!isMemoryKind(input.kind)) throw new MemoryMutationError(`Unknown memory kind "${input.kind}".`);
    if (!input.title.trim()) throw new MemoryMutationError("A memory entry needs a title.");
    if (!input.provider.trim()) throw new MemoryMutationError("A memory entry needs a provider.");
    if (!input.externalId.trim()) throw new MemoryMutationError("A memory entry needs an externalId.");

    const id = newId("mem");
    this.db
      .prepare(
        `INSERT INTO crew_memory_refs
           (id, company_id, provider, external_id, kind, title, path, task_id, project_id, agent_id,
            source, confidence, sensitivity)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.provider,
        input.externalId,
        input.kind,
        input.title,
        input.path ?? null,
        input.taskId ?? null,
        input.projectId ?? null,
        input.agentId ?? null,
        input.source ?? "",
        input.confidence ?? 1.0,
        input.sensitivity ?? "internal",
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "memory.recorded",
      entityType: "memory",
      entityId: id,
      taskId: input.taskId ?? undefined,
      details: { title: input.title, kind: input.kind, provider: input.provider },
    });

    return this.get(id)!;
  }

  get(id: string): MemoryRefRow | null {
    return oneRow<MemoryRefRow>(this.db.prepare("SELECT * FROM crew_memory_refs WHERE id = ?"), id);
  }

  list(
    companyId: string,
    opts: { kind?: MemoryKind; taskId?: string; projectId?: string; agentId?: string } = {},
  ): MemoryRefRow[] {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.taskId) {
      clauses.push("task_id = ?");
      params.push(opts.taskId);
    }
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.agentId) {
      clauses.push("agent_id = ?");
      params.push(opts.agentId);
    }
    return allRows<MemoryRefRow>(
      this.db.prepare(
        `SELECT * FROM crew_memory_refs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC`,
      ),
      ...params,
    );
  }

  /** Returns true when a row was deleted, false when it did not exist. */
  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const memory = this.get(id);
    if (!memory) return false;
    this.db.prepare("DELETE FROM crew_memory_refs WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: memory.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "memory.deleted",
      entityType: "memory",
      entityId: id,
      details: { title: memory.title, provider: memory.provider },
    });
    return true;
  }
}
