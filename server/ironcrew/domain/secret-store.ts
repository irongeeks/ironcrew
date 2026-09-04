/**
 * IronCrew — secret ref repository.
 *
 * Stores WHERE a secret lives (provider + item locator), never the secret
 * itself — see docs/THREAT_MODEL.md and secrets/secret-ref.ts. Registering,
 * renaming or deleting a ref is audited (it is a governance-relevant change
 * to what an agent or operator can reach), but the audit details only ever
 * carry the ref's metadata (name, provider, item_ref) — never a resolved
 * value, which this store never even sees.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { isSecretProviderKind, type SecretProviderKind } from "../secrets/secret-ref.ts";

export interface SecretRow {
  id: string;
  company_id: string;
  name: string;
  provider: SecretProviderKind;
  item_ref: string;
  field: string | null;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface CreateSecretInput {
  companyId: string;
  name: string;
  provider: SecretProviderKind;
  itemRef: string;
  field?: string | null;
  description?: string;
  actorType?: ActorType;
  actorId?: string;
}

export class SecretMutationError extends Error {}

export class SecretStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateSecretInput): SecretRow {
    if (!isSecretProviderKind(input.provider)) {
      throw new SecretMutationError(`Unknown secret provider "${input.provider}".`);
    }
    if (!input.name.trim()) throw new SecretMutationError("A secret ref needs a name.");
    if (!input.itemRef.trim()) throw new SecretMutationError("A secret ref needs an itemRef.");
    if (this.getByName(input.companyId, input.name)) {
      throw new SecretMutationError(`A secret named "${input.name}" already exists for this company.`);
    }

    const id = newId("secret");
    this.db
      .prepare(
        `INSERT INTO crew_secrets (id, company_id, name, provider, item_ref, field, description)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.name,
        input.provider,
        input.itemRef,
        input.field ?? null,
        input.description ?? "",
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "owner",
      actorId: input.actorId ?? "ceo",
      action: "secret.registered",
      entityType: "secret",
      entityId: id,
      details: { name: input.name, provider: input.provider, itemRef: input.itemRef },
    });

    return this.get(id)!;
  }

  get(id: string): SecretRow | null {
    return oneRow<SecretRow>(this.db.prepare("SELECT * FROM crew_secrets WHERE id = ?"), id);
  }

  getByName(companyId: string, name: string): SecretRow | null {
    return oneRow<SecretRow>(
      this.db.prepare("SELECT * FROM crew_secrets WHERE company_id = ? AND name = ?"),
      companyId,
      name,
    );
  }

  list(companyId: string): SecretRow[] {
    return allRows<SecretRow>(
      this.db.prepare("SELECT * FROM crew_secrets WHERE company_id = ? ORDER BY name ASC, rowid ASC"),
      companyId,
    );
  }

  update(
    id: string,
    patch: { name?: string; itemRef?: string; field?: string | null; description?: string },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): SecretRow | null {
    const secret = this.get(id);
    if (!secret) return null;
    if (patch.name !== undefined && patch.name !== secret.name) {
      const clash = this.getByName(secret.company_id, patch.name);
      if (clash && clash.id !== id) {
        throw new SecretMutationError(`A secret named "${patch.name}" already exists for this company.`);
      }
    }

    this.db
      .prepare(
        `UPDATE crew_secrets
         SET name = COALESCE(?, name),
             item_ref = COALESCE(?, item_ref),
             field = CASE WHEN ? THEN ? ELSE field END,
             description = COALESCE(?, description),
             updated_at = unixepoch()*1000
         WHERE id = ?`,
      )
      .run(
        patch.name ?? null,
        patch.itemRef ?? null,
        patch.field !== undefined ? 1 : 0,
        patch.field ?? null,
        patch.description ?? null,
        id,
      );

    appendAuditEvent(this.db, {
      companyId: secret.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "secret.updated",
      entityType: "secret",
      entityId: id,
      details: { name: patch.name, itemRef: patch.itemRef },
    });

    return this.get(id);
  }

  /** Returns true when a row was deleted, false when it did not exist. */
  delete(id: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const secret = this.get(id);
    if (!secret) return false;
    this.db.prepare("DELETE FROM crew_secrets WHERE id = ?").run(id);

    appendAuditEvent(this.db, {
      companyId: secret.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "secret.deleted",
      entityType: "secret",
      entityId: id,
      details: { name: secret.name, provider: secret.provider },
    });
    return true;
  }
}
