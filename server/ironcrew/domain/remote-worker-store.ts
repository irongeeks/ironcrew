/**
 * IronCrew — remote worker repository.
 *
 * A remote worker is an SSH connection target reached over a tailnet
 * (Tailscale or a self-hosted, protocol-compatible control server such as
 * Headscale) — a Tier0 environment or a customer's network that IronCrew
 * can act inside. Only the connection metadata is stored; `private_key_path`
 * is a filesystem path the server reads at connect time, never key material
 * in the row — see the migration's own comment.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export type KnownHostsPolicy = "strict" | "accept";

export interface RemoteWorkerRow {
  id: string;
  company_id: string;
  label: string;
  environment: string;
  host: string;
  port: number;
  ssh_user: string;
  private_key_path: string;
  known_hosts_policy: KnownHostsPolicy;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface CreateRemoteWorkerInput {
  companyId: string;
  label: string;
  environment?: string;
  host: string;
  port?: number;
  sshUser: string;
  privateKeyPath: string;
  knownHostsPolicy?: KnownHostsPolicy;
  notes?: string;
  actorType?: ActorType;
  actorId?: string;
}

export class RemoteWorkerMutationError extends Error {}

export class RemoteWorkerStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateRemoteWorkerInput): RemoteWorkerRow {
    if (!input.label.trim()) throw new RemoteWorkerMutationError("A remote worker needs a label.");
    if (!input.host.trim()) throw new RemoteWorkerMutationError("A remote worker needs a host.");
    if (!input.sshUser.trim()) throw new RemoteWorkerMutationError("A remote worker needs an SSH user.");
    if (!input.privateKeyPath.trim()) throw new RemoteWorkerMutationError("A remote worker needs a private key path.");
    if (this.getByLabel(input.companyId, input.label)) {
      throw new RemoteWorkerMutationError(`A remote worker labeled "${input.label}" already exists for this company.`);
    }

    const id = newId("worker");
    this.db
      .prepare(
        `INSERT INTO crew_remote_workers
           (id, company_id, label, environment, host, port, ssh_user, private_key_path, known_hosts_policy, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.label,
        input.environment ?? "",
        input.host,
        input.port ?? 22,
        input.sshUser,
        input.privateKeyPath,
        input.knownHostsPolicy ?? "strict",
        input.notes ?? "",
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "remote_worker.registered",
      entityType: "remote_worker",
      entityId: id,
      details: { label: input.label, environment: input.environment ?? "", host: input.host },
    });

    return this.get(id)!;
  }

  get(id: string): RemoteWorkerRow | null {
    return oneRow<RemoteWorkerRow>(this.db.prepare("SELECT * FROM crew_remote_workers WHERE id = ?"), id);
  }

  getByLabel(companyId: string, label: string): RemoteWorkerRow | null {
    return oneRow<RemoteWorkerRow>(
      this.db.prepare("SELECT * FROM crew_remote_workers WHERE company_id = ? AND label = ?"),
      companyId,
      label,
    );
  }

  list(companyId: string): RemoteWorkerRow[] {
    return allRows<RemoteWorkerRow>(
      this.db.prepare("SELECT * FROM crew_remote_workers WHERE company_id = ? ORDER BY label ASC, rowid ASC"),
      companyId,
    );
  }

  /** Returns true when a row was deleted, false when it did not exist. */
  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const worker = this.get(id);
    if (!worker) return false;
    this.db.prepare("DELETE FROM crew_remote_workers WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: worker.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "remote_worker.deleted",
      entityType: "remote_worker",
      entityId: id,
      details: { label: worker.label, host: worker.host },
    });
    return true;
  }
}
